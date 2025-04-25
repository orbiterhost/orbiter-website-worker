import { PinataSDK } from 'pinata-web3';
import { classifyRequest, getHashedIp, getNormalizedReferrer, trackPageView } from './utils/analytics';

export interface Env {
	ALCHEMY_URL: string;
	ORBITER_SITES: KVNamespace;
	SITE_CONTRACT: KVNamespace;
	PINATA_GATEWAY: string;
	SITE_PLANS: KVNamespace;
	SITE_TO_ORG: KVNamespace;
	RATE_LIMIT: KVNamespace;
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
			let classification;

			try {
				classification = classifyRequest(request, reqUrl.pathname);
			} catch (error) {
				console.error('Classification failed:', error);
				classification = { isBot: true, isAsset: false, shouldTrack: false };
			}

			if (classification.shouldTrack) {
				const referer = request.headers.get('referer');
				const normalizedReferer = referer ? getNormalizedReferrer(referer) : 'direct';

				const ip = request.headers.get('x-forwarded-for');
				let hashIp = '';

				if (ip) {
					hashIp = await getHashedIp(ip)
				}

				// Non-blocking analytics
				trackPageView(env, {
					siteId: reqUrl.hostname,
					path: reqUrl.pathname,
					userAgent: request.headers.get('user-agent') || '',
					country: request.headers.get('cf-ipcountry') || '',
					city: request.headers.get('cf-ipcity') || '',
					referrer: normalizedReferer,
					ipAddress: hashIp || '',
				}).catch((error) => console.error('Analytics failed:', error));
			}

			const versionCid = reqUrl.searchParams.get('orbiterVersionCid');

			const pathName = reqUrl.pathname;
			const hostname = reqUrl.hostname;

			// Block PHP file requests early
			if (pathName.toLowerCase().endsWith('.php')) {
				return new Response('Not Found', {
					status: 404,
					headers: {
						'Content-Type': 'text/plain',
						'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
					},
				});
			}

			let siteKey = hostname.endsWith('orbiter.website') ? hostname.split('.')[0] : hostname;

			const orgId = (await env.SITE_TO_ORG.get(siteKey)) || '0';

			//	Get site CID and plan
			let [siteCid, plan, contract] = await Promise.all([env.ORBITER_SITES.get(siteKey), env.SITE_PLANS.get(orgId), env.SITE_CONTRACT.get(siteKey)]);

			const isUsingVersionCid = versionCid && (await pinata.gateways.containsCID(versionCid));
			const cid = isUsingVersionCid ? versionCid : siteCid;

			if (!cid) {
				throw new Error(`Failed to fetch latest state: ${cid}`);
			}

			// Get base IPFS URL
			let gatewayUrl = await pinata.gateways.convert(cid as string);
			let response: Response | null = null;
			
			// IMPORTANT: Check if this is a relative path to the current page context
			const refererUrl = referrer ? new URL(referrer) : null;
			let cleanPath = pathName.startsWith('/') ? pathName.slice(1) : pathName;
			
			// For all asset requests that have a referrer, we need to consider the referrer's path context
			if (refererUrl && refererUrl.pathname !== '/' && pathName !== '/') {
				// Get only the directory part of the referrer path
				let refererDir = refererUrl.pathname;
				
				// If the referrer path includes a file with extension, remove the file part
				if (refererDir.includes('.') && !refererDir.endsWith('/')) {
					refererDir = refererDir.substring(0, refererDir.lastIndexOf('/') + 1);
				} else if (!refererDir.endsWith('/')) {
					// Ensure directory paths end with a slash
					refererDir = refererDir + '/';
				}
				
				// For absolute paths in the request (starting with /), we use them as is
				// For relative paths (no leading /), we need to resolve them against the referrer directory
				if (!pathName.startsWith('/')) {
					// First, trim the leading slash from the referrer directory
					const trimmedRefererDir = refererDir.startsWith('/') ? refererDir.slice(1) : refererDir;
					
					// Combine the referrer directory with the requested path
					cleanPath = `${trimmedRefererDir}${cleanPath}`;
				}
			}

			if (pathName && pathName !== '/') {
				if (!cleanPath.includes('.')) {
					// First, try fetching index.html from the directory
					const indexPath = `${gatewayUrl}/${cleanPath}/index.html`;
					response = await fetch(indexPath);

					// If that fails, try appending .html to the path
					if (!response.ok) {
						const htmlPath = `${gatewayUrl}/${cleanPath}.html`;
						response = await fetch(htmlPath);
					}
				} else {
					// Path includes an extension, fetch directly
					response = await fetch(`${gatewayUrl}/${cleanPath}`);
				}
			} else {
				// Root path, fetch index.html
				response = await fetch(`${gatewayUrl}/index.html`);
			}

			// If all attempts fail, try as a single file
			if (!response?.ok) {
				console.log('All failed final check');
				gatewayUrl = gatewayUrl.split('/index.html')[0];
				response = await fetch(gatewayUrl);
			}

			const contentType = response.headers.get('Content-Type') || 'text/html';
			let body: any = response.body;
			// If this is an HTML file, we need to rewrite any asset URLs
			if (contentType?.includes('text/html')) {
				const text = await response.text();
				// We need to modify all relative URLs to include the current path context
				// First, properly format the current path context for base URL
				let currentPathContext = pathName;
				
				// Make sure the path ends with a slash for directory contexts
				if (!currentPathContext.endsWith('/') && !currentPathContext.includes('.')) {
					currentPathContext += '/';
				} else if (currentPathContext.includes('.')) {
					// For file paths, get just the directory part
					currentPathContext = currentPathContext.substring(0, currentPathContext.lastIndexOf('/') + 1);
				}
				
				// For the root path, use empty string as context
				if (currentPathContext === '/') {
					currentPathContext = '';
				}
			
				// Prepare a proper base URL for the HTML (must be absolute)
				const baseUrl = `${reqUrl.protocol}//${reqUrl.host}${currentPathContext}`;
				
				// Add a base tag to help browser resolve relative URLs correctly
				let modifiedHtml = text;
				if (!modifiedHtml.includes('<base ')) {
					// Insert base tag after head if it exists
					if (modifiedHtml.includes('<head>')) {
						modifiedHtml = modifiedHtml.replace('<head>', `<head>\n<base href="${baseUrl}">`);
					} else {
						// Otherwise try to add it at the beginning of the HTML
						modifiedHtml = `<base href="${baseUrl}">\n${modifiedHtml}`;
					}
				}
				
				// IMPORTANT: We still want to process relative URLs in the HTML
				// but instead of keeping them relative, we need to make them include
				// the current path context explicitly
				modifiedHtml = modifiedHtml.replace(/(src|href)=("|')(?!http|\/\/|data:|#|mailto:)([^"']*)("|')/g, (match, attr, quote, path) => {
					let assetPath;
					
					// If path starts with /, it's already absolute from root
					if (path.startsWith('/')) {
						assetPath = path;
					} else {
						// For relative paths, prepend the current path context
						// This is the key fix - explicitly include the directory context
						assetPath = currentPathContext + path;
					}
					
					// Add the version CID to the URL if we're using one
					const versionParam = isUsingVersionCid ? `?orbiterVersionCid=${versionCid}` : '';
					return `${attr}=${quote}${assetPath}${versionParam}${quote}`;
				});

				body = modifiedHtml;
			}

			// Create response with appropriate headers
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: {
					'Content-Type': contentType || 'text/plain',
					'Access-Control-Allow-Origin': '*',
					'Cache-Control': 'public, max-age=3600',
					'Powered-By': 'Orbiter', 
					'orb-cid': cid || "", 
					'orb-contract': contract || ""
				},
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