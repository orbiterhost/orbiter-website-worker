import { PinataSDK } from "pinata-web3";
import {
	classifyRequest,
	getHashedIp,
	getNormalizedReferrer,
	trackPageView,
} from "./utils/analytics";

export interface Env {
	ALCHEMY_URL: string;
	ORBITER_SITES: KVNamespace;
	SITE_CONTRACT: KVNamespace;
	PINATA_GATEWAY: string;
	SITE_PLANS: KVNamespace;
	SITE_TO_ORG: KVNamespace;
	RATE_LIMIT: KVNamespace;
	REDIRECTS: KVNamespace;
	
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
	// ... your existing range request logic
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
			'Range': `bytes=${range.start}-${range.end}`
		}
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

// NEW: Handle API requests by proxying to customer worker
async function handleApiRequest(
	request: Request,
	env: Env,
	siteKey: string
): Promise<Response | null> {
	
	// Look up the customer's API worker for this site
	const workerKey = `worker:${siteKey}`; // Single API worker per site
	const workerData = await env.FUNCTIONS.get(workerKey);
	
	if (!workerData) {
		// No API worker deployed for this site
		return new Response(JSON.stringify({
			error: 'API not available',
			message: 'No API worker deployed for this site'
		}), {
			status: 404,
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			}
		});
	}
	
	try {
		const workerInfo = JSON.parse(workerData);
		
		// Get the worker from the dispatch namespace
		const worker = env.dispatcher.get(workerInfo.deployedName);
		
		// Create a new request with /_api stripped from the path
		// So /_api/contact becomes /contact for the customer's worker
		const url = new URL(request.url);
		const hostname = url.hostname;
		const apiPath = url.pathname.substring(5); // Remove '/_api'
		const newUrl = new URL(apiPath || '/', url.origin);
		newUrl.search = url.search; // Preserve query parameters
		
		const apiRequest = new Request(newUrl.toString(), {
			method: request.method,
			headers: request.headers,
			body: request.body,
		});
		
		// Forward the request to the customer's worker
		const response = await worker.fetch(apiRequest);
		
		// Add CORS headers to the response
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization',
		};
		
		// Handle OPTIONS requests for CORS
		if (request.method === 'OPTIONS') {
			return new Response(null, { 
				status: 200, 
				headers: corsHeaders 
			});
		}
		
		// Clone response and add CORS headers
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
			return new Response(JSON.stringify({
				error: 'API worker not found',
				message: 'The API worker has been deleted or is not deployed'
			}), {
				status: 404,
				headers: {
					'Content-Type': 'application/json',
					'Access-Control-Allow-Origin': '*',
				}
			});
		}
		
		return new Response(JSON.stringify({
			error: 'API error',
			message: 'Internal server error'
		}), {
			status: 500,
			headers: {
				'Content-Type': 'application/json',
				'Access-Control-Allow-Origin': '*',
			}
		});
	}
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const pinata = new PinataSDK({
			pinataJwt: "",
			pinataGateway: env.PINATA_GATEWAY,
		});

		try {
			const reqUrl = new URL(request.url);
			const referrer = request.headers.get("referer");
			const pathName = reqUrl.pathname;
			const hostname = reqUrl.hostname;

			// Block PHP file requests early
			if (pathName.toLowerCase().endsWith(".php")) {
				return new Response("Not Found", {
					status: 404,
					headers: {
						"Content-Type": "text/plain",
						"Cache-Control": "public, max-age=86400",
					},
				});
			}

			let siteKey = hostname.endsWith("orbiter.website")
				? hostname.split(".")[0]
				: hostname;

			// NEW: Check if this is an API request
			if (pathName.startsWith('/_api/')) {
				return await handleApiRequest(request, env, siteKey) || new Response(null);
			}

			// Continue with your existing static site logic...
			let classification;
			try {
				classification = classifyRequest(request, reqUrl.pathname);
			} catch (error) {
				console.error("Classification failed:", error);
				classification = { isBot: true, isAsset: false, shouldTrack: false };
			}

			if (classification.shouldTrack) {
				const referer = request.headers.get("referer");
				const normalizedReferer = referer
					? getNormalizedReferrer(referer)
					: "direct";

				const ip = request.headers.get("x-forwarded-for");
				let hashIp = "";

				if (ip) {
					hashIp = await getHashedIp(ip);
				}

				trackPageView(env, {
					siteId: reqUrl.hostname,
					path: reqUrl.pathname,
					userAgent: request.headers.get("user-agent") || "",
					country: request.headers.get("cf-ipcountry") || "",
					city: request.headers.get("cf-ipcity") || "",
					referrer: normalizedReferer,
					ipAddress: hashIp || "",
				}).catch((error) => console.error("Analytics failed:", error));
			}

			const versionCid = reqUrl.searchParams.get("orbiterVersionCid");
			const orgId = (await env.SITE_TO_ORG.get(siteKey)) || "0";

			// Your existing static site logic continues here...
			let siteCid = "bafybeie2chscyvn2llxhl2l4aftmop2cvqqjmznvbwedytvi4wiyw2xrva"
			let plan = "orbit"
			let contract = "0x"

			let redirectsArray: Redirect[] = [];

			if (plan !== "free") {
				const originalHost =
					request.headers.get("X-Original-Host") || reqUrl.host;
				console.log("Checking redirects");
				const redirectsPlain = await env.REDIRECTS.get(siteKey);

				if (redirectsPlain) {
					redirectsArray = JSON.parse(redirectsPlain);
					for (const redirect of redirectsArray) {
						const sourcePath = redirect?.source?.startsWith("/")
							? redirect?.source
							: `/${redirect?.source}`;
						const currentPath = pathName;

						let destinationPath = redirect?.destination;
						if (
							(destinationPath && destinationPath?.startsWith("http://")) ||
							destinationPath?.startsWith("https://")
						) {
							try {
								const destinationUrl = new URL(destinationPath);
								destinationPath =
									destinationUrl.pathname +
									destinationUrl.search +
									destinationUrl.hash;
							} catch (e) {
								console.error("Invalid destination URL:", destinationPath);
							}
						} else if (!destinationPath?.startsWith("/")) {
							destinationPath = `/${destinationPath}`;
						}

						if (currentPath === destinationPath) {
							continue;
						}

						if (
							currentPath === sourcePath ||
							(redirect.force && currentPath.startsWith(sourcePath))
						) {
							let destinationUrl = redirect.destination;

							if (
								!destinationUrl.startsWith("http://") &&
								!destinationUrl.startsWith("https://")
							) {
								destinationUrl = `${reqUrl.protocol}//${originalHost}${destinationUrl.startsWith("/") ? "" : "/"}${destinationUrl}`;
							}

							return new Response(null, {
								status: redirect?.status || 301,
								headers: {
									Location: destinationUrl,
									"Cache-Control": "public, max-age=3600",
									"Powered-By": "Orbiter",
									"orb-cid": siteCid || "",
									"orb-contract": contract || "",
								},
							});
						}
					}
				}
			}

			// Rest of your existing static site logic...
			const isUsingVersionCid =
				versionCid && (await pinata.gateways.containsCID(versionCid));
			const cid = isUsingVersionCid ? versionCid : siteCid;

			if (!cid) {
				throw new Error(`Failed to fetch latest state: ${cid}`);
			}

			let gatewayUrl = await pinata.gateways.convert(cid as string);
			let response: Response | null = null;

			const refererUrl = referrer ? new URL(referrer) : null;
			let cleanPath = pathName.startsWith("/") ? pathName.slice(1) : pathName;

			if (refererUrl && refererUrl.pathname !== "/" && pathName !== "/") {
				let refererDir = refererUrl.pathname;

				if (refererDir.includes(".") && !refererDir.endsWith("/")) {
					refererDir = refererDir.substring(0, refererDir.lastIndexOf("/") + 1);
				} else if (!refererDir.endsWith("/")) {
					refererDir = refererDir + "/";
				}

				if (!pathName.startsWith("/")) {
					const trimmedRefererDir = refererDir.startsWith("/")
						? refererDir.slice(1)
						: refererDir;

					cleanPath = `${trimmedRefererDir}${cleanPath}`;
				}
			}

			if (pathName && pathName !== "/") {
				const rangeHeader = request.headers.get('Range');
				
				if (!cleanPath.includes(".")) {
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
					const custom404 = redirectsArray.find(
						(redirect) => redirect.source === "404",
					);

					if (custom404) {
						console.log("Using custom 404 page");
						const notFoundPath = custom404.destination.startsWith("/")
							? custom404.destination.slice(1)
							: custom404.destination;

						const notFoundResponse = await fetch(
							`${gatewayUrl}/${notFoundPath}.html`,
						);

						if (notFoundResponse.ok) {
							const contentType =
								notFoundResponse.headers.get("Content-Type") || "text/html";
							return new Response(notFoundResponse.body, {
								status: 404,
								headers: {
									"Content-Type": contentType,
									"Cache-Control": "public, max-age=3600",
									"Powered-By": "Orbiter",
									"orb-cid": cid || "",
									"orb-contract": contract || "",
								},
							});
						}
					}
				}

				console.log("All failed final check");
				gatewayUrl = gatewayUrl.split("/index.html")[0];
				response = await fetch(gatewayUrl);
			}

			const contentType = response.headers.get("Content-Type") || "text/html";
			let body: any = response.body;
			
			if (contentType?.includes("text/html")) {
				const text = await response.text();
				let currentPathContext = pathName;

				if (
					!currentPathContext.endsWith("/") &&
					!currentPathContext.includes(".")
				) {
					currentPathContext += "/";
				} else if (currentPathContext.includes(".")) {
					currentPathContext = currentPathContext.substring(
						0,
						currentPathContext.lastIndexOf("/") + 1,
					);
				}

				if (currentPathContext === "/") {
					currentPathContext = "";
				}

				const originalHost =
					request.headers.get("X-Original-Host") || reqUrl.host;
				const baseUrl = `${reqUrl.protocol}//${originalHost}${currentPathContext}`;

				let modifiedHtml = text;
				if (!modifiedHtml.includes("<base ")) {
					if (modifiedHtml.includes("<head>")) {
						modifiedHtml = modifiedHtml.replace(
							"<head>",
							`<head>\n<base href="${baseUrl}">`,
						);
					} else {
						modifiedHtml = `<base href="${baseUrl}">\n${modifiedHtml}`;
					}
				}

				modifiedHtml = modifiedHtml.replace(
					/(src|href)=("|')(?!http|\/\/|data:|#|mailto:)([^"']*)("|')/g,
					(match, attr, quote, path) => {
						let assetPath;

						if (path.startsWith("/")) {
							assetPath = path;
						} else {
							assetPath = currentPathContext + path;
						}

						const versionParam = isUsingVersionCid
							? `?orbiterVersionCid=${versionCid}`
							: "";
						return `${attr}=${quote}${assetPath}${versionParam}${quote}`;
					},
				);

				body = modifiedHtml;
			}

			const isMediaFile = cleanPath.match(/\.(mp4|webm|ogg|mov|avi|mkv|mp3|wav|flac|aac|m4a)$/i);
			
			const responseHeaders: Record<string, string> = {
				"Content-Type": contentType || "text/plain",
				"Access-Control-Allow-Origin": "*",
				"Cache-Control": "public, max-age=3600",
				"Powered-By": "Orbiter",
				"orb-cid": cid || "",
				"orb-contract": contract || "",
			};

			if (isMediaFile) {
				responseHeaders["Accept-Ranges"] = "bytes";
			}

			return new Response(body, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		} catch (error) {
			console.error("Error:", error);
			return new Response(`Error: ${error}`, {
				status: 500,
				headers: { "Content-Type": "text/plain" },
			});
		}
	},
} satisfies ExportedHandler<Env>;