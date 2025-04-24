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
			let classification;
			try {
				classification = classifyRequest(request, reqUrl.pathname);
			} catch (e) {
				console.error('Classification failed:', e);
				classification = { isBot: true, isAsset: false, shouldTrack: false };
			}

			if (classification.shouldTrack) {
				const referer = request.headers.get('referer') ?? 'direct';
				const ip = request.headers.get('x-forwarded-for') || '';
				const hashIp = ip ? await getHashedIp(ip) : '';
				trackPageView(env, {
					siteId: reqUrl.hostname,
					path: reqUrl.pathname,
					userAgent: request.headers.get('user-agent') || '',
					country: request.headers.get('cf-ipcountry') || '',
					city: request.headers.get('cf-ipcity') || '',
					referrer: getNormalizedReferrer(referer),
					ipAddress: hashIp,
				}).catch((e) => console.error('Analytics failed:', e));
			}

			// block PHP
			if (reqUrl.pathname.toLowerCase().endsWith('.php')) {
				return new Response('Not Found', {
					status: 404,
					headers: {
						'Content-Type': 'text/plain',
						'Cache-Control': 'public, max-age=86400',
					},
				});
			}

			const siteKey = reqUrl.hostname.endsWith('orbiter.website') ? reqUrl.hostname.split('.')[0] : reqUrl.hostname;
			const [siteCid, contract] = await Promise.all([env.ORBITER_SITES.get(siteKey), env.SITE_CONTRACT.get(siteKey)]);

			const versionCid = reqUrl.searchParams.get('orbiterVersionCid');
			const isUsingVersionCid = Boolean(versionCid) && (await pinata.gateways.containsCID(versionCid!));

			//const cid = 'bafybeibtzn6aotnryxg3midegpdh5g33zti4ic3j4j7qqrew3a2ee7mypu';
			const cid = 'bafybeicnwk7xwd54jsxkfaij4t3cdmqx3opfpp372l4amhiqymuo3n5iai'; //isUsingVersionCid ? versionCid : siteCid;
			if (!cid) throw new Error(`No CID for site ${siteKey}`);

			const gatewayUrl = await pinata.gateways.convert(cid);
			let response: Response | null = null;
			const cleanPath = reqUrl.pathname.slice(1);

			if (reqUrl.pathname === '/' || cleanPath === '') {
				response = await fetch(`${gatewayUrl}/index.html`);
			} else if (!cleanPath.includes('.')) {
				response = await fetch(`${gatewayUrl}/${cleanPath}/index.html`);
				if (!response.ok) {
					response = await fetch(`${gatewayUrl}/${cleanPath}.html`);
				}
			} else {
				response = await fetch(`${gatewayUrl}/${cleanPath}`);
			}
			if (!response?.ok) {
				// final fallback to root CID
				response = await fetch(gatewayUrl);
			}

			// Now the HTMLRewriter integration:
			const contentType = response.headers.get('Content-Type') || 'text/html';
			let finalResponse: Response;
			if (contentType.includes('text/html')) {
				// build a base URL that always ends in "/"
				const baseUrl = new URL(request.url);
				if (!baseUrl.pathname.endsWith('/')) {
					baseUrl.pathname += '/';
				}

				const rewriter = new HTMLRewriter()
					// your existing asset‐tag rewrite
					.on('img,script,link,audio,video,source,embed,iframe,object,canvas', {
						element(el) {
							const attr = el.tagName === 'link' ? 'href' : 'src';
							const val = el.getAttribute(attr);
							if (val && !/^https?:\/\//.test(val) && !val.startsWith('data:')) {
								// If the path doesn't start with a slash, ensure it's treated as relative
								// to the current path (preserve /person/ prefix)
								let resolved;
								if (!val.startsWith('/')) {
									// For relative paths, preserve the current directory context
									resolved = new URL(val, baseUrl).pathname;
								} else {
									// For absolute paths (starting with /), use as is
									resolved = val;
								}
								const suffix = isUsingVersionCid ? `?orbiterVersionCid=${versionCid}` : '';
								el.setAttribute(attr, `${resolved}${suffix}`);
							}
						},
					})
					.on('style', {
						text(textNode) {
							const css = textNode.text;
							const rewritten = css.replace(/url\(\s*(['"]?)(?!https?:\/\/|\/\/|data:)(.+?)\1\s*\)/g, (_match, quote, path) => {
								let resolved;
								if (!path.startsWith('/')) {
									// For relative paths, preserve the current directory context
									resolved = new URL(path, baseUrl).pathname;
								} else {
									// For absolute paths (starting with /), use as is
									resolved = path;
								}
								const suffix = isUsingVersionCid ? `?orbiterVersionCid=${versionCid}` : '';
								return `url(${quote}${resolved}${suffix}${quote})`;
							});
							if (rewritten !== css) {
								textNode.replace(rewritten, { html: false });
							}
						},
					})
					.on('*[style]', {
						element(el) {
							const style = el.getAttribute('style');
							if (style && style.includes('url(')) {
								const rewritten = style.replace(/url\(\s*(['"]?)(?!https?:\/\/|\/\/|data:)(.+?)\1\s*\)/g, (_match, quote, path) => {
									let resolved;
									if (!path.startsWith('/')) {
										// For relative paths, preserve the current directory context
										resolved = new URL(path, baseUrl).pathname;
									} else {
										// For absolute paths (starting with /), use as is
										resolved = path;
									}
									const suffix = isUsingVersionCid ? `?orbiterVersionCid=${versionCid}` : '';
									return `url(${quote}${resolved}${suffix}${quote})`;
								});

								if (rewritten !== style) {
									el.setAttribute('style', rewritten);
								}
							}
						},
					});

				finalResponse = rewriter.transform(response);
			} else if(contentType.includes('javascript')) {
				console.log("Javascript loaded");
				console.log(response);
				finalResponse = response;
			} else {
				finalResponse = response;
			}

			const headers = new Headers(finalResponse.headers);
			headers.set('Content-Type', contentType);
			headers.set('Access-Control-Allow-Origin', '*');
			headers.set('Cache-Control', 'public, max-age=3600');
			headers.set('Powered-By', 'Orbiter');
			headers.set('orb-cid', cid);
			headers.set('orb-contract', contract || '');

			return new Response(finalResponse.body, {
				status: finalResponse.status,
				statusText: finalResponse.statusText,
				headers,
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
