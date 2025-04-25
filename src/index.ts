import { PinataSDK } from 'pinata-web3';
import { classifyRequest, getHashedIp, getNormalizedReferrer, trackPageView } from './utils/analytics';
import { Context } from 'hono';

export interface Env {
	ALCHEMY_URL: string;
	ORBITER_SITES: KVNamespace;
	SITE_CONTRACT: KVNamespace;
	PINATA_GATEWAY: string;
	SITE_PLANS: KVNamespace;
	SITE_TO_ORG: KVNamespace;
	RATE_LIMIT: KVNamespace;
	SITES_BUCKET: R2Bucket;
}

// Map file extensions to content types
const contentTypeMap: any = {
	// HTML and document types
	html: 'text/html',
	htm: 'text/html',
	xhtml: 'application/xhtml+xml',
	txt: 'text/plain',
	md: 'text/markdown',
	pdf: 'application/pdf',
	xml: 'application/xml',

	// Styles, scripts and data
	css: 'text/css',
	js: 'text/javascript',
	mjs: 'text/javascript', // ES modules
	jsx: 'text/javascript',
	ts: 'text/javascript',
	tsx: 'text/javascript',
	json: 'application/json',
	map: 'application/json', // Source maps

	// Images
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	tiff: 'image/tiff',
	tif: 'image/tiff',

	// Fonts
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	eot: 'application/vnd.ms-fontobject',

	// Audio/Video
	mp4: 'video/mp4',
	webm: 'video/webm',
	ogg: 'audio/ogg',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	m4a: 'audio/mp4',
	m4v: 'video/mp4',
	mov: 'video/quicktime',

	// Web app specific
	manifest: 'application/manifest+json',
	webapp: 'application/x-web-app-manifest+json',
	appcache: 'text/cache-manifest',
	webmanifest: 'application/manifest+json',

	// Other
	zip: 'application/zip',
	gz: 'application/gzip',
	tar: 'application/x-tar',
	csv: 'text/csv',
	ics: 'text/calendar',
};

// Cache control settings optimized for different asset types
const CACHE_CONTROL = {
	// Long-lived assets (30 days)
	immutable: {
		ttl: 2592000,
		extensions: [
			// Hashed assets (typically from bundlers like webpack, vite, etc.)
			/\.[0-9a-f]{8,}\.(js|css|png|jpg|jpeg|gif|webp|svg|woff|woff2|ttf|otf)$/i,
		],
		directive: 'public, max-age=2592000, immutable',
	},

	// Static assets (7 days)
	static: {
		ttl: 604800,
		extensions: [
			'.jpg',
			'.jpeg',
			'.png',
			'.gif',
			'.webp',
			'.avif',
			'.svg',
			'.css',
			'.js',
			'.mjs',
			'.woff',
			'.woff2',
			'.ttf',
			'.otf',
			'.eot',
			'.mp4',
			'.webm',
			'.mp3',
			'.ogg',
			'.wav',
			'.pdf',
			'.ico',
		],
		directive: 'public, max-age=604800',
	},

	// JSON and API responses (5 minutes)
	api: {
		ttl: 300,
		extensions: ['.json', '.xml'],
		directive: 'public, max-age=300',
	},

	// HTML and other documents (1 minute - good for fast iterations during development)
	html: {
		ttl: 60,
		extensions: ['.html', '.htm', '.xhtml', '.md', '.txt'],
		directive: 'public, max-age=60',
	},

	// Special files that should never be cached
	noCache: {
		extensions: ['service-worker.js', 'sw.js', 'manifest.json', 'manifest.webmanifest', 'robots.txt', 'sitemap.xml'],
		directive: 'no-cache',
	},
};

export default {
	async fetch(request: Request, env: Env, ctx: Context) {
		try {
			// Only handle GET requests
			if (request.method !== 'GET') {
				return new Response('Method Not Allowed', { status: 405 });
			}

			// Get the domain and URL details
			const url = new URL(request.url);
			const domain = url.hostname;
			let path = url.pathname;
			const referrer = request.headers.get('referer');

			console.log({ domain, path, referrer });

			// Create an array of paths to try, in order of priority
			const pathsToTry = [];

			// Development environment path adjustment
			if (referrer && referrer.includes('localhost') && referrer.includes('/person') && !path.startsWith('/person/')) {
				// Add adjusted path with /person prefix
				pathsToTry.push(`/person${path}`);
				console.log(`Development environment detected. Added adjusted path: /person${path}`);
			}

			// Original path
			pathsToTry.push(path);

			// Handle clean URLs (without file extensions)
			if (!path.includes('.')) {
				// If path doesn't end with slash, try as a clean URL with .html
				if (!path.endsWith('/')) {
					pathsToTry.push(`${path}.html`);

					// Also add the dev-environment adjusted version
					if (referrer && referrer.includes('localhost')) {
						pathsToTry.push(`/person${path}.html`);
					}
				}

				// Try as directory with index.html
				const dirPath = path.endsWith('/') ? path : `${path}/`;
				pathsToTry.push(`${dirPath}index.html`);

				// Also add the dev-environment adjusted version
				if (referrer && referrer.includes('localhost')) {
					pathsToTry.push(`/person${dirPath}index.html`);
				}
			}

			console.log('Paths to try:', pathsToTry);

			// Get the bucket from the environment
			const bucket = env.SITES_BUCKET;

			// Try each path in order
			for (const currentPath of pathsToTry) {
				const key = currentPath.startsWith('/') ? currentPath.substring(1) : currentPath;
				const fullKey = `${domain}/${key}`;

				console.log(`Looking for: ${fullKey}`);

				const object = await bucket.get(fullKey);

				if (object !== null) {
					return serveR2Object(object, key);
				}
			}

			// Not found, return 404
			const notFoundKey = `${domain}/404.html`;
			const notFoundObject = await bucket.get(notFoundKey);
			if (notFoundObject !== null) {
				return new Response(await notFoundObject.arrayBuffer(), {
					status: 404,
					headers: {
						'Content-Type': 'text/html',
						'Cache-Control': CACHE_CONTROL.html.directive,
					},
				});
			}

			return new Response('Not Found', {
				status: 404,
				headers: { 'Content-Type': 'text/plain' },
			});
		} catch (error: any) {
			console.error(`Worker error: ${error.stack || error}`);
			return new Response('Internal Server Error', {
				status: 500,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	},
};

/**
 * Attempts to serve an asset from R2 with smart path handling
 */
async function serveAsset(bucket: R2Bucket, domain: string, path: string) {
	// These are the paths we'll try in order
	const pathsToTry = [];

	// Normalize the path
	const normalizedPath = path === '/' ? '/index.html' : path;

	// 1. First try the exact path requested
	pathsToTry.push(normalizedPath);

	// 2. For paths without file extensions, try these options:
	if (!normalizedPath.includes('.')) {
		// a. Path with .html extension (e.g., /about -> /about.html)
		pathsToTry.push(`${normalizedPath}.html`);

		// b. Path as a directory with index.html (e.g., /about -> /about/index.html)
		const directoryPath = normalizedPath.endsWith('/') ? `${normalizedPath}index.html` : `${normalizedPath}/index.html`;
		pathsToTry.push(directoryPath);
	}

	// 3. For directory paths ending with /, add index.html
	else if (normalizedPath.endsWith('/')) {
		pathsToTry.push(`${normalizedPath}index.html`);
	}

	// 4. For SPA applications, we'll fallback to root index.html for routes that don't exist
	const isSPARequest = !path.includes('.') && path !== '/';

	// Try each path in order
	for (const pathToTry of pathsToTry) {
		// Remove leading slash for R2 storage key
		const key = pathToTry.startsWith('/') ? pathToTry.substring(1) : pathToTry;
		const fullKey = `${domain}/${key}`;

		// Try to get the object from R2
		const object = await bucket.get(fullKey);

		if (object !== null) {
			// We found it! Serve the asset with appropriate headers
			return serveR2Object(object, key);
		}
	}

	// For SPA apps, if no file was found, fallback to index.html
	// (but only if we're not already looking for a static asset)
	if (isSPARequest) {
		const indexObject = await bucket.get(`${domain}/index.html`);
		if (indexObject !== null) {
			return serveR2Object(indexObject, 'index.html');
		}
	}

	// We couldn't find the requested asset, try a custom 404 page
	const notFoundObject = await bucket.get(`${domain}/404.html`);
	if (notFoundObject !== null) {
		return new Response(await notFoundObject.arrayBuffer(), {
			status: 404,
			headers: {
				'Content-Type': 'text/html',
				'Cache-Control': CACHE_CONTROL.html.directive,
			},
		});
	}

	// Fallback to a basic 404 response
	return new Response('Not Found', {
		status: 404,
		headers: { 'Content-Type': 'text/plain' },
	});
}

/**
 * Helper function to serve an R2 object with proper headers
 */
function serveR2Object(object: any, key: string) {
	// Determine file extension and content type
	const fileExtension = key && key.includes('.') ? key?.split('.')?.pop()?.toLowerCase() : '';
	const contentType = contentTypeMap[fileExtension || ''] || 'application/octet-stream';

	// Determine cache control directive based on file type
	let cacheControl = 'public, max-age=3600'; // Default 1 hour

	// Check for immutable assets (containing hashes)
	if (CACHE_CONTROL.immutable.extensions.some((pattern) => (typeof pattern === 'string' ? key.endsWith(pattern) : pattern.test(key)))) {
		cacheControl = CACHE_CONTROL.immutable.directive;
	}
	// Check for no-cache assets
	else if (CACHE_CONTROL.noCache.extensions.some((ext) => key.endsWith(ext))) {
		cacheControl = CACHE_CONTROL.noCache.directive;
	}
	// Check for static assets
	else if (CACHE_CONTROL.static.extensions.some((ext) => key.endsWith(ext))) {
		cacheControl = CACHE_CONTROL.static.directive;
	}
	// Check for API responses
	else if (CACHE_CONTROL.api.extensions.some((ext) => key.endsWith(ext))) {
		cacheControl = CACHE_CONTROL.api.directive;
	}
	// Check for HTML and other documents
	else if (CACHE_CONTROL.html.extensions.some((ext) => key.endsWith(ext))) {
		cacheControl = CACHE_CONTROL.html.directive;
	}

	// Return the response with appropriate headers
	return new Response(object.body, {
		headers: {
			'Content-Type': contentType,
			'Content-Length': object.size,
			'Cache-Control': cacheControl,
			ETag: object.httpEtag,
			'Accept-Ranges': 'bytes',
			...(contentType === 'text/html'
				? {
						'X-Content-Type-Options': 'nosniff',
						'X-Frame-Options': 'SAMEORIGIN',
						'Referrer-Policy': 'strict-origin-when-cross-origin',
				  }
				: {}),
		},
	});
}
