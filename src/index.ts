import { PinataSDK } from 'pinata-web3';
import { banner } from './utils/banner';
import { classifyRequest, getHashedIp, getNormalizedReferrer, trackPageView } from './utils/analytics';

export interface Env {
	ALCHEMY_URL: string;
	ORBITER_SITES: KVNamespace;
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
				console.log("IP: ", ip);
				let hashIp = '';

				if (ip) {
					console.log({ip});
					hashIp = await getHashedIp(ip)
					console.log({hashIp});
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

			console.log({ siteKey });

			const orgId = (await env.SITE_TO_ORG.get(siteKey)) || '0';

			console.log({ orgId });

			//	Get site CID and plan
			let [siteCid, plan] = await Promise.all([env.ORBITER_SITES.get(siteKey), env.SITE_PLANS.get(orgId)]);

			const isUsingVersionCid = versionCid && (await pinata.gateways.containsCID(versionCid));
			const cid = isUsingVersionCid ? versionCid : siteCid;

			console.log({ cid });

			// //	@TODO this is a manual hack to not show the banner on our orbiter.host site
			// if (siteKey === "marketing") {
			// 	plan = 'orbit';
			// }

			if (!cid) {
				throw new Error(`Failed to fetch latest state: ${cid}`);
			}

			// Get base IPFS URL
			let gatewayUrl = await pinata.gateways.convert(cid as string);
			let response: Response | null = null;

			if (pathName && pathName !== '/') {
				const cleanPath = pathName.startsWith('/') ? pathName.slice(1) : pathName;
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
			// If this is an HTML file, we need to rewrite any asset URLs and potentially inject the banner
			if (contentType?.includes('text/html')) {
				const text = await response.text();
				// Rewrite relative URLs for assets AND add the version CID if we're using one
				const modifiedHtml = text.replace(/(src|href)=("|')(?!http|\/\/|data:)([^"']*)("|')/g, (match, attr, quote, path) => {
					// If path starts with /, it's already absolute
					const assetPath = path.startsWith('/') ? path : `/${path}`;
					// Add the version CID to the URL if we're using one
					const versionParam = isUsingVersionCid ? `?orbiterVersionCid=${versionCid}` : '';
					return `${attr}=${quote}${assetPath}${versionParam}${quote}`;
				});

				body = modifiedHtml;

				// Inject banner if site is on free plan
				if (plan === 'free' || !plan) {
					body = body.replace('</body>', `${banner}</body>`);
				}
			}

			// Create response with appropriate headers
			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: {
					'Content-Type': contentType || 'text/plain',
					'Access-Control-Allow-Origin': '*',
					'Cache-Control': 'public, max-age=3600',
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
