import { PinataSDK } from 'pinata-web3';
import { classifyRequest, getHashedIp, getNormalizedReferrer, trackPageView } from './utils/analytics';

export interface Env {
	ALCHEMY_URL: string;
	ORBITER_ADMIN_KEY: string;
	ORBITER_SITES: KVNamespace;
	SITE_CONTRACT: KVNamespace;
	PINATA_GATEWAY: string;
	SITE_PLANS: KVNamespace;
	SITE_TO_ORG: KVNamespace;
	RATE_LIMIT: KVNamespace;
	REDIRECTS: KVNamespace;
	CUSTOM_DOMAINS: KVNamespace; // For new Cloudflare for SaaS domains
	LEGACY_DOMAINS: KVNamespace; // For tracking old Digital Ocean domains

	// NEW: Add these for SSL challenge handling
	CLOUDFLARE_API_TOKEN: string;
	CLOUDFLARE_ZONE_ID: string;

	// Add dispatcher binding for API requests
	dispatcher: Dispatcher;
	FUNCTIONS: KVNamespace; // For looking up customer workers
}

interface Dispatcher {
	get: (
		scriptName: string,
		args?: { init?: RequestInit },
		getOptions?: {
			limits?: { cpuMs?: number; memory?: number };
			outbound?: string;
		}
	) => Worker;
}

interface Worker {
	fetch: (request: Request) => Promise<Response>;
}

interface Redirect {
	source: string;
	destination: string;
	status: number;
	force?: boolean;
}

interface CustomDomainMapping {
	subdomain: string;
	created: string;
	cloudflare_hostname_id?: string;
	worker_route_id?: string;
	type: 'cloudflare-saas'; // New domains use Cloudflare for SaaS
}

interface LegacyDomainMapping {
	subdomain: string;
	created: string;
	type: 'digital-ocean'; // Legacy domains through Digital Ocean
}

// Enhanced domain resolution with dual-mode support
async function resolveSiteKey(hostname: string, env: Env): Promise<{
	siteKey: string;
	domainType: 'native' | 'cloudflare-saas' | 'digital-ocean';
	isLegacy: boolean;
}> {
	console.log(`Resolving hostname: ${hostname}`);

	// 1. Check if it's a native *.orbiter.website domain
	if (hostname.endsWith('orbiter.website')) {
		const siteKey = hostname.split('.')[0];
		return {
			siteKey,
			domainType: 'native',
			isLegacy: false
		};
	}

	// 2. Check if it's a new Cloudflare for SaaS custom domain
	const customDomainMapping = await env.CUSTOM_DOMAINS.get(hostname);
	if (customDomainMapping) {
		const mapping: CustomDomainMapping = JSON.parse(customDomainMapping);
		console.log(`Cloudflare for SaaS domain ${hostname} maps to subdomain: ${mapping.subdomain}`);
		return {
			siteKey: mapping.subdomain,
			domainType: 'cloudflare-saas',
			isLegacy: false
		};
	}

	// 3. Check if it's a legacy Digital Ocean domain
	const legacyDomainMapping = await env.LEGACY_DOMAINS.get(hostname);
	if (legacyDomainMapping) {
		const mapping: LegacyDomainMapping = JSON.parse(legacyDomainMapping);
		console.log(`Legacy Digital Ocean domain ${hostname} maps to subdomain: ${mapping.subdomain}`);
		return {
			siteKey: mapping.subdomain,
			domainType: 'digital-ocean',
			isLegacy: true
		};
	}

	// 4. Fallback: treat unknown domains as potential legacy domains
	// This handles existing customers whose domains weren't in LEGACY_DOMAINS yet
	console.log(`Unknown domain ${hostname}, treating as potential legacy domain`);
	return {
		siteKey: hostname,
		domainType: 'digital-ocean',
		isLegacy: true
	};
}

// NEW: Handle SSL validation challenges
async function handleSSLValidationChallenge(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const hostname = url.hostname;
	const pathName = url.pathname;
	
	console.log(`SSL validation challenge request: ${hostname}${pathName}`);

	// Handle ACME challenge (for SSL certificate validation)
	if (pathName.startsWith('/.well-known/acme-challenge/')) {
		const token = pathName.split('/').pop();
		console.log(`ACME challenge token: ${token}`);
		
		// Get the domain mapping to find the custom hostname ID
		const domainMapping = await getDomainMapping(hostname, env);
		if (!domainMapping) {
			console.log(`No domain mapping found for ${hostname}`);
			return new Response('Domain not configured', { status: 404 });
		}

		// Get the current challenge details from Cloudflare
		try {
			const customHostname = await getCustomHostnameStatus(domainMapping.cloudflare_hostname_id, env);
			
			// Find the matching validation record
			const validationRecord = customHostname.ssl.validation_records?.find((record: any) => 
				record.http_url && record.http_url.includes(token)
			);

			if (validationRecord && validationRecord.http_body) {
				console.log(`Serving ACME challenge for ${hostname}: ${validationRecord.http_body}`);
				return new Response(validationRecord.http_body, {
					status: 200,
					headers: {
						'Content-Type': 'text/plain',
						'Cache-Control': 'no-cache'
					}
				});
			}

			console.log(`No matching validation record found for token: ${token}`);
			return new Response('Challenge not found', { status: 404 });

		} catch (error) {
			console.error('Error fetching validation challenge:', error);
			return new Response('Error retrieving challenge', { status: 500 });
		}
	}

	// Handle Cloudflare custom hostname challenge (for domain ownership)
	if (pathName.startsWith('/.well-known/cf-custom-hostname-challenge/')) {
		const challengeId = pathName.split('/').pop();
		console.log(`CF custom hostname challenge: ${challengeId}`);
		
		// Get the domain mapping
		const domainMapping = await getDomainMapping(hostname, env);
		if (!domainMapping) {
			console.log(`No domain mapping found for ${hostname}`);
			return new Response('Domain not configured', { status: 404 });
		}

		// Get the ownership verification details from Cloudflare
		try {
			const customHostname = await getCustomHostnameStatus(domainMapping.cloudflare_hostname_id, env);
			
			if (customHostname.ownership_verification_http && 
				customHostname.ownership_verification_http.http_url.includes(challengeId)) {
				
				console.log(`Serving CF hostname challenge for ${hostname}: ${customHostname.ownership_verification_http.http_body}`);
				return new Response(customHostname.ownership_verification_http.http_body, {
					status: 200,
					headers: {
						'Content-Type': 'text/plain',
						'Cache-Control': 'no-cache'
					}
				});
			}

			console.log(`No matching ownership verification found for: ${challengeId}`);
			return new Response('Challenge not found', { status: 404 });

		} catch (error) {
			console.error('Error fetching ownership challenge:', error);
			return new Response('Error retrieving challenge', { status: 500 });
		}
	}

	// Unknown .well-known path
	console.log(`Unknown .well-known path: ${pathName}`);
	return new Response('Not found', { status: 404 });
}

// NEW: Helper function to get domain mapping
async function getDomainMapping(hostname: string, env: Env): Promise<any> {
	// Check custom domains first
	const customMapping = await env.CUSTOM_DOMAINS.get(hostname);
	if (customMapping) {
		return JSON.parse(customMapping);
	}

	// Check legacy domains
	const legacyMapping = await env.LEGACY_DOMAINS.get(hostname);
	if (legacyMapping) {
		return JSON.parse(legacyMapping);
	}

	return null;
}

// NEW: Helper function to get custom hostname status
async function getCustomHostnameStatus(customHostnameId: string, env: Env): Promise<any> {
	const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${customHostnameId}`, {
		headers: {
			'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
		}
	});
	
	const data = await response.json() as any;
	return data.result;
}

// Helper function to parse Range header
function parseRangeHeader(rangeHeader: string, contentLength: number): { start: number; end: number } | null {
	const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
	if (!match) return null;

	const start = parseInt(match[1], 10);
	const end = match[2] ? parseInt(match[2], 10) : contentLength - 1;

	if (start >= contentLength || end >= contentLength || start > end) {
		return null;
	}

	return { start, end };
}

// Helper function to handle range requests for media files
async function handleRangeRequest(
	gatewayUrl: string,
	cleanPath: string,
	rangeHeader: string,
	cid: string,
	contract: string
): Promise<Response> {
	const headResponse = await fetch(`${gatewayUrl}/${cleanPath}`, { method: 'HEAD' });
	if (!headResponse.ok) {
		return new Response('File not found', { status: 404 });
	}

	const contentLength = parseInt(headResponse.headers.get('Content-Length') || '0', 10);
	if (!contentLength) {
		const fullResponse = await fetch(`${gatewayUrl}/${cleanPath}`);
		return new Response(fullResponse.body, {
			status: 200,
			headers: {
				'Content-Type': fullResponse.headers.get('Content-Type') || 'application/octet-stream',
				'Content-Length': fullResponse.headers.get('Content-Length') || '0',
				'Accept-Ranges': 'bytes',
				'Cache-Control': 'public, max-age=3600',
				'Powered-By': 'Orbiter',
				'orb-cid': cid || '',
				'orb-contract': contract || '',
			},
		});
	}

	const range = parseRangeHeader(rangeHeader, contentLength);
	if (!range) {
		return new Response('Invalid range', { status: 416 });
	}

	const rangeResponse = await fetch(`${gatewayUrl}/${cleanPath}`, {
		headers: {
			Range: `bytes=${range.start}-${range.end}`,
		},
	});

	if (!rangeResponse.ok) {
		const fullResponse = await fetch(`${gatewayUrl}/${cleanPath}`);
		return new Response(fullResponse.body, {
			status: 200,
			headers: {
				'Content-Type': fullResponse.headers.get('Content-Type') || 'application/octet-stream',
				'Content-Length': contentLength.toString(),
				'Accept-Ranges': 'bytes',
				'Cache-Control': 'public, max-age=3600',
				'Powered-By': 'Orbiter',
				'orb-cid': cid || '',
				'orb-contract': contract || '',
			},
		});
	}

	const contentRange = `bytes ${range.start}-${range.end}/${contentLength}`;
	const partialContentLength = range.end - range.start + 1;

	return new Response(rangeResponse.body, {
		status: 206,
		headers: {
			'Content-Type': rangeResponse.headers.get('Content-Type') || 'application/octet-stream',
			'Content-Length': partialContentLength.toString(),
			'Content-Range': contentRange,
			'Accept-Ranges': 'bytes',
			'Cache-Control': 'public, max-age=3600',
			'Powered-By': 'Orbiter',
			'orb-cid': cid || '',
			'orb-contract': contract || '',
		},
	});
}

// Handle API requests by proxying to customer worker
async function handleApiRequest(request: Request, env: Env, siteKey: string): Promise<Response | null> {
	const workerKey = `worker:${siteKey}`;
	console.log({ workerKey });
	const workerData = await env.FUNCTIONS.get(workerKey);

	if (!workerData) {
		console.log('NO WORKER DATA');
		return new Response(
			JSON.stringify({
				error: 'API not available',
				message: 'No API worker deployed for this site',
			}),
			{
				status: 404,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			}
		);
	}

	try {
		const workerInfo = JSON.parse(workerData);
		const worker = env.dispatcher.get(workerInfo.deployedName);

		const url = new URL(request.url);
		const apiPath = url.pathname.substring(5); // Remove '/api'
		const newUrl = new URL(apiPath || '/', url.origin);
		newUrl.search = url.search;

		const apiRequest = new Request(newUrl.toString(), {
			method: request.method,
			headers: request.headers,
			body: request.body,
		});

		const response = await worker.fetch(apiRequest);

		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		};

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 200,
				headers: corsHeaders,
			});
		}

		const responseWithCors = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: {
				...Object.fromEntries(response.headers.entries()),
				...corsHeaders,
				'Powered-By': 'Orbiter API',
			},
		});

		return responseWithCors;
	} catch (error) {
		console.error('API worker execution error:', error);

		if (error instanceof Error && error.message.includes('Worker not found')) {
			return new Response(
				JSON.stringify({
					error: 'API worker not found',
					message: 'The API worker has been deleted or is not deployed',
				}),
				{
					status: 404,
					headers: {
						'Content-Type': 'application/json',
						'Access-Control-Allow-Origin': '*',
					},
				}
			);
		}

		return new Response(
			JSON.stringify({
				error: 'API error',
				message: 'Internal server error',
			}),
			{
				status: 500,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				},
			}
		);
	}
}

// Enhanced admin endpoint to manage both domain types
async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	
	// Verify admin token
	const authHeader = request.headers.get('Authorization');
	const token = authHeader?.split(' ')[1];
	
	if (!token || token !== env.ORBITER_ADMIN_KEY) {
		return new Response('Unauthorized', { status: 401 });
	}

	// Create new Cloudflare for SaaS domain mapping
	if (path === '/admin/custom-domains' && request.method === 'POST') {
		try {
			const body: any = await request.json();
			const { domain, subdomain, cloudflare_hostname_id, worker_route_id } = body;
			
			const mapping: CustomDomainMapping = {
				subdomain,
				created: new Date().toISOString(),
				cloudflare_hostname_id,
				worker_route_id,
				type: 'cloudflare-saas'
			};
			
			await env.CUSTOM_DOMAINS.put(domain, JSON.stringify(mapping));
			
			return new Response(JSON.stringify({
				status: 'success',
				message: 'Cloudflare for SaaS domain mapping created',
				domain,
				mapping
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			return new Response(JSON.stringify({
				error: 'Failed to create custom domain mapping',
				details: error instanceof Error ? error.message : 'Unknown error'
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}

	// Create legacy domain mapping (for existing Digital Ocean domains)
	if (path === '/admin/legacy-domains' && request.method === 'POST') {
		try {
			const body: any = await request.json();
			const { domain, subdomain } = body;
			
			const mapping: LegacyDomainMapping = {
				subdomain,
				created: new Date().toISOString(),
				type: 'digital-ocean'
			};
			
			await env.LEGACY_DOMAINS.put(domain, JSON.stringify(mapping));
			
			return new Response(JSON.stringify({
				status: 'success',
				message: 'Legacy domain mapping created',
				domain,
				mapping
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			return new Response(JSON.stringify({
				error: 'Failed to create legacy domain mapping',
				details: error instanceof Error ? error.message : 'Unknown error'
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}

	// Delete domain mappings
	if (path === '/admin/custom-domains' && request.method === 'DELETE') {
		try {
			const body: any = await request.json();
			const { domain } = body;
			await env.CUSTOM_DOMAINS.delete(domain);
			
			return new Response(JSON.stringify({
				status: 'success',
				message: 'Custom domain mapping deleted'
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			return new Response(JSON.stringify({
				error: 'Failed to delete custom domain mapping',
				details: error instanceof Error ? error.message : 'Unknown error'
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}

	if (path === '/admin/legacy-domains' && request.method === 'DELETE') {
		try {
			const body: any = await request.json();
			const { domain } = body;
			await env.LEGACY_DOMAINS.delete(domain);
			
			return new Response(JSON.stringify({
				status: 'success',
				message: 'Legacy domain mapping deleted'
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			return new Response(JSON.stringify({
				error: 'Failed to delete legacy domain mapping',
				details: error instanceof Error ? error.message : 'Unknown error'
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}

	// Get domain info (useful for debugging)
	if (path === '/admin/domain-info' && request.method === 'GET') {
		try {
			const domain = url.searchParams.get('domain');
			if (!domain) {
				return new Response('Domain parameter required', { status: 400 });
			}

			const resolution = await resolveSiteKey(domain, env);
			
			return new Response(JSON.stringify({
				domain,
				resolution,
				timestamp: new Date().toISOString()
			}), {
				headers: { 'Content-Type': 'application/json' }
			});
		} catch (error) {
			return new Response(JSON.stringify({
				error: 'Failed to get domain info',
				details: error instanceof Error ? error.message : 'Unknown error'
			}), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}

	return new Response('Not Found', { status: 404 });
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const pinata = new PinataSDK({
			pinataJwt: '',
			pinataGateway: env.PINATA_GATEWAY,
		});

		try {
			const reqUrl = new URL(request.url);
			const referrer = request.headers.get('referer');
			const pathName = reqUrl.pathname;
			const hostname = reqUrl.hostname;

			// HANDLE SSL VALIDATION CHALLENGES FIRST - This must come before any other logic
			if (pathName.startsWith('/.well-known/') && !pathName.includes("farcaster.json")) {
				return await handleSSLValidationChallenge(request, env);
			}

			// Handle admin requests
			if (pathName.startsWith('/admin/')) {
				return await handleAdminRequest(request, env);
			}

			// Block PHP file requests early
			if (pathName.toLowerCase().endsWith('.php')) {
				return new Response('Not Found', {
					status: 404,
					headers: {
						'Content-Type': 'text/plain',
						'Cache-Control': 'public, max-age=86400',
					},
				});
			}

			// Enhanced domain resolution with dual-mode support
			const domainResolution = await resolveSiteKey(hostname, env);
			const siteKey = domainResolution.siteKey;
			
			console.log(`Domain Resolution:`, {
				hostname,
				siteKey,
				domainType: domainResolution.domainType,
				isLegacy: domainResolution.isLegacy
			});

			const versionCid = reqUrl.searchParams.get('orbiterVersionCid');
			const orgId = (await env.SITE_TO_ORG.get(siteKey)) || '0';

			let [siteCid, plan, contract] = await Promise.all([
				env.ORBITER_SITES.get(siteKey),
				env.SITE_PLANS.get(orgId),
				env.SITE_CONTRACT.get(siteKey),
			]);

			const referer = request.headers.get('referer');
			const normalizedReferer = referer ? getNormalizedReferrer(referer) : 'direct';

			const ip = request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip');
			let hashIp = '';

			if (ip) {
				hashIp = await getHashedIp(ip);
			}

			const requestType = pathName.startsWith('/api/') ? 'api' : 'static';
			
			// Enhanced analytics tracking with domain type information
			trackPageView(env, {
				siteId: hostname, // Use original hostname for analytics
				path: reqUrl.pathname,
				userAgent: request.headers.get('user-agent') || '',
				country: request.headers.get('cf-ipcountry') || '',
				city: request.headers.get('cf-ipcity') || '',
				referrer: normalizedReferer,
				ipAddress: hashIp || '',
				requestType,
			}).catch((error) => console.error('Analytics failed:', error));

			// Check if this is an API request
			if (pathName.startsWith('/api/') && plan !== 'free') {
				return (await handleApiRequest(request, env, siteKey)) || new Response(null);
			}

			let redirectsArray: Redirect[] = [];

			if (plan !== 'free') {
				// Handle original host header properly for both domain types
				const originalHost = request.headers.get('X-Original-Host') || reqUrl.host;
				console.log('Checking redirects for siteKey:', siteKey);
				const redirectsPlain = await env.REDIRECTS.get(siteKey);

				if (redirectsPlain) {
					redirectsArray = JSON.parse(redirectsPlain);
					for (const redirect of redirectsArray) {
						const sourcePath = redirect?.source?.startsWith('/') ? redirect?.source : `/${redirect?.source}`;
						const currentPath = pathName;

						let destinationPath = redirect?.destination;
						if ((destinationPath && destinationPath?.startsWith('http://')) || destinationPath?.startsWith('https://')) {
							try {
								const destinationUrl = new URL(destinationPath);
								destinationPath = destinationUrl.pathname + destinationUrl.search + destinationUrl.hash;
							} catch (e) {
								console.error('Invalid destination URL:', destinationPath);
							}
						} else if (!destinationPath?.startsWith('/')) {
							destinationPath = `/${destinationPath}`;
						}

						if (currentPath === destinationPath) {
							continue;
						}

						if (currentPath === sourcePath || (redirect.force && currentPath.startsWith(sourcePath))) {
							let destinationUrl = redirect.destination;

							if (!destinationUrl.startsWith('http://') && !destinationUrl.startsWith('https://')) {
								destinationUrl = `${reqUrl.protocol}//${originalHost}${destinationUrl.startsWith('/') ? '' : '/'}${destinationUrl}`;
							}

							return new Response(null, {
								status: redirect?.status || 301,
								headers: {
									Location: destinationUrl,
									'Cache-Control': 'public, max-age=3600',
									'Powered-By': 'Orbiter',
									'orb-cid': siteCid || '',
									'orb-contract': contract || '',
									// Add domain type header for debugging
									'orb-domain-type': domainResolution.domainType,
								},
							});
						}
					}
				}
			}

			// Rest of your existing static site logic remains the same...
			const isUsingVersionCid = versionCid && (await pinata.gateways.containsCID(versionCid));
			const cid = isUsingVersionCid ? versionCid : siteCid;

			if (!cid) {
				throw new Error(`Failed to fetch site data for siteKey: ${siteKey}`);
			}

			let gatewayUrl = await pinata.gateways.convert(cid as string);
			let response: Response | null = null;

			const refererUrl = referrer ? new URL(referrer) : null;
			let cleanPath = pathName.startsWith('/') ? pathName.slice(1) : pathName;

			if (refererUrl && refererUrl.pathname !== '/' && pathName !== '/') {
				let refererDir = refererUrl.pathname;

				if (refererDir.includes('.') && !refererDir.endsWith('/')) {
					refererDir = refererDir.substring(0, refererDir.lastIndexOf('/') + 1);
				} else if (!refererDir.endsWith('/')) {
					refererDir = refererDir + '/';
				}

				if (!pathName.startsWith('/')) {
					const trimmedRefererDir = refererDir.startsWith('/') ? refererDir.slice(1) : refererDir;
					cleanPath = `${trimmedRefererDir}${cleanPath}`;
				}
			}

			if (pathName && pathName !== '/') {
				const rangeHeader = request.headers.get('Range');

				if (!cleanPath.includes('.')) {
					const indexPath = `${gatewayUrl}/${cleanPath}/index.html`;
					response = await fetch(indexPath);

					if (!response.ok) {
						const htmlPath = `${gatewayUrl}/${cleanPath}.html`;
						response = await fetch(htmlPath);
					}
				} else {
					const isMediaFile = cleanPath.match(/\.(mp4|webm|ogg|mov|avi|mkv|mp3|wav|flac|aac|m4a)$/i);

					if (isMediaFile && rangeHeader) {
						return await handleRangeRequest(gatewayUrl, cleanPath, rangeHeader, cid as string, contract || '');
					} else {
						response = await fetch(`${gatewayUrl}/${cleanPath}`);
					}
				}
			} else {
				response = await fetch(`${gatewayUrl}/index.html`);
			}

			if (!response?.ok) {
				if (redirectsArray.length > 0) {
					const custom404 = redirectsArray.find((redirect) => redirect.source === '404');

					if (custom404) {
						console.log('Using custom 404 page');
						const notFoundPath = custom404.destination.startsWith('/') ? custom404.destination.slice(1) : custom404.destination;

						const notFoundResponse = await fetch(`${gatewayUrl}/${notFoundPath}.html`);

						if (notFoundResponse.ok) {
							const contentType = notFoundResponse.headers.get('Content-Type') || 'text/html';
							return new Response(notFoundResponse.body, {
								status: 404,
								headers: {
									'Content-Type': contentType,
									'Cache-Control': 'public, max-age=3600',
									'Powered-By': 'Orbiter',
									'orb-cid': cid || '',
									'orb-contract': contract || '',
									'orb-domain-type': domainResolution.domainType,
								},
							});
						}
					}
				}

				console.log('All failed final check');
				gatewayUrl = gatewayUrl.split('/index.html')[0];
				response = await fetch(gatewayUrl);
			}

			const contentType = response.headers.get('Content-Type') || 'text/html';
			let body: any = response.body;

			if (contentType?.includes('text/html')) {
				const text = await response.text();
				let currentPathContext = pathName;

				if (!currentPathContext.endsWith('/') && !currentPathContext.includes('.')) {
					currentPathContext += '/';
				} else if (currentPathContext.includes('.')) {
					currentPathContext = currentPathContext.substring(0, currentPathContext.lastIndexOf('/') + 1);
				}

				if (currentPathContext === '/') {
					currentPathContext = '';
				}

				// Use the original hostname for base URL construction
				const originalHost = request.headers.get('X-Original-Host') || reqUrl.host;
				const baseUrl = `${reqUrl.protocol}//${originalHost}${currentPathContext}`;

				let modifiedHtml = text;
				if (!modifiedHtml.includes('<base ')) {
					if (modifiedHtml.includes('<head>')) {
						modifiedHtml = modifiedHtml.replace('<head>', `<head>\n<base href="${baseUrl}">`);
					} else {
						modifiedHtml = `<base href="${baseUrl}">\n${modifiedHtml}`;
					}
				}

				modifiedHtml = modifiedHtml.replace(/(src|href)=("|')(?!http|\/\/|data:|#|mailto:)([^"']*)("|')/g, (match, attr, quote, path) => {
					let assetPath;

					if (path.startsWith('/')) {
						assetPath = path;
					} else {
						assetPath = currentPathContext + path;
					}

					const versionParam = isUsingVersionCid ? `?orbiterVersionCid=${versionCid}` : '';
					return `${attr}=${quote}${assetPath}${versionParam}${quote}`;
				});

				body = modifiedHtml;
			}

			const isMediaFile = cleanPath.match(/\.(mp4|webm|ogg|mov|avi|mkv|mp3|wav|flac|aac|m4a)$/i);

			const responseHeaders: Record<string, string> = {
				'Content-Type': contentType || 'text/plain',
				'Access-Control-Allow-Origin': '*',
				'Cache-Control': 'public, max-age=3600',
				'Powered-By': 'Orbiter',
				'orb-cid': cid || '',
				'orb-contract': contract || '',
				'orb-domain-type': domainResolution.domainType,
			};

			if (isMediaFile) {
				responseHeaders['Accept-Ranges'] = 'bytes';
			}

			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		} catch (error) {
			console.error('Error:', error);
			return new Response(`Error: ${error}`, {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	},
} satisfies ExportedHandler<Env>;