import { Env } from '..';

interface RequestClassification {
	isBot: boolean;
	isAsset: boolean;
	shouldTrack: boolean;
}

// Known bot patterns and suspicious behaviors
const BOT_PATTERNS = [
	// Common bot strings
	'bot',
	'crawler',
	'spider',
	'headless',
	// Specific bots
	'googlebot',
	'bingbot',
	'baiduspider',
	'yandexbot',
	'facebookexternalhit',
	'gptbot',
	'chatgpt-user',
	'ccbot',
	'anthropic-ai',
	'claude-web',
	'cohere-ai',
	'facebookbot',
	'twitterbot',
	'ahrefsbot',
	'applebot',
	'petalbot',
	'semrushbot',
	'duckduckbot',
	'archive.org_bot',
	// Additional patterns
	'phantomjs',
	'selenium',
	'webdriver',
	'cypress',
	'puppeteer',
	'playwright',
];

// Asset extensions to ignore
const ASSET_EXTENSIONS = [
	'.css',
	'.js',
	'.jpg',
	'.jpeg',
	'.png',
	'.gif',
	'.svg',
	'.ico',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.mp4',
	'.webm',
	'.mp3',
	'.wav',
	'.pdf',
	'.json',
	'.xml',
	'.webmanifest',
	'.php',
];

export function classifyRequest(request: Request, pathname: string): RequestClassification {
	try {
		const userAgent = (request.headers.get('User-Agent') || '').toLowerCase();
		const acceptHeader = (request.headers.get('Accept') || '').toLowerCase();

		// Enhanced bot detection
		const isBot = detectBot(userAgent, request.headers);

		// Improved asset detection
		const isAsset = detectAsset(pathname, acceptHeader);

		// Track only non-bot HTML page requests with additional filtering
		const shouldTrack = !isBot && !isAsset && isTrackableRequest(pathname, request.method);

		return { isBot, isAsset, shouldTrack };
	} catch (error) {
		console.error('Error in request classification:', error);
		return { isBot: true, isAsset: false, shouldTrack: false };
	}
}

function detectBot(userAgent: string, headers: Headers): boolean {
	// Empty or suspicious user agents
	if (!userAgent || userAgent.length < 5) return true;

	// Check known bot patterns
	if (BOT_PATTERNS.some((pattern) => userAgent.includes(pattern))) return true;

	// Check for missing or suspicious headers that browsers typically have
	const acceptLanguage = headers.get('Accept-Language');
	const acceptEncoding = headers.get('Accept-Encoding');

	if (!acceptLanguage && !acceptEncoding) return true;

	// Additional suspicious patterns
	const hasDatacenterIP = headers.get('cf-ipcountry') === 'T1'; // Cloudflare datacenter detection
	const forwardedFor = headers.get('X-Forwarded-For');
	const suspiciousHeaders = forwardedFor ? forwardedFor.split(',').length > 3 : false;

	return hasDatacenterIP || suspiciousHeaders;
}

function detectAsset(pathname: string, acceptHeader: string): boolean {
	// Check file extensions
	const extension = pathname.split('.').pop()?.toLowerCase();
	if (extension && ASSET_EXTENSIONS.includes(`.${extension}`)) return true;

	// Check accept headers for asset content types
	const assetContentTypes = [
		'image/',
		'font/',
		'style',
		'script',
		'application/javascript',
		'text/css',
		'application/font',
		'audio/',
		'video/',
	];

	return assetContentTypes.some((type) => acceptHeader.includes(type));
}

function isTrackableRequest(pathname: string, method: string): boolean {
	// Only track GET requests
	if (method !== 'GET') return false;

	// Track root path and HTML pages
	if (pathname === '/' || pathname.endsWith('.html')) return true;

	// Track paths without extensions (likely dynamic routes)
	if (!pathname.includes('.')) return true;

	return false;
}

export async function trackPageView(
	env: Env,
	data: {
		siteId: string;
		path: string;
		userAgent: string;
		referrer: string;
		country: string;
		city: string;
		ipAddress: string;
		requestType: string;
	}
): Promise<void> {
	try {
		// Rate limiting by IP (you'll need to implement storage)

		const canTrack = await checkRateLimit(env, data.siteId, data.ipAddress);

		if (!canTrack) {
			console.log('Rate limited request:', `${data.siteId}:${data.ipAddress}`);
			return;
		}

		// Normalize path
		data.path = normalizePath(data.path);

		await fetch('https://analytics.orbiter.host/analytics', {
			method: 'POST',
			body: JSON.stringify({
				...data,
				timestamp: new Date().toISOString(),
				sessionId: generateSessionId(data),
			}),
			headers: {
				'Content-Type': 'application/json',
				'X-Orbiter-Analytics-Token': env.ORBITER_ADMIN_KEY,
			},
		});
	} catch (error) {
		console.error('Failed to track page view:', error);
	}
}

// Helper function to normalize paths
function normalizePath(path: string): string {
	// Remove trailing slashes
	path = path.replace(/\/+$/, '');

	// Remove query parameters and fragments
	path = path.split('?')[0].split('#')[0];

	// Ensure path starts with /
	if (!path.startsWith('/')) path = '/' + path;

	return path;
}

// Helper function to generate a consistent session ID
function generateSessionId(data: { ipAddress: string; userAgent: string }): string {
	const base = `${data.ipAddress}:${data.userAgent}`;
	// Use a hash function here, for example:
	return cyrb53(base).toString(16);
}

// Simple hash function (cyrb53)
function cyrb53(str: string): number {
	let h1 = 0xdeadbeef,
		h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

async function checkRateLimit(env: Env, siteId: string, ipAddress: string): Promise<boolean> {
	try {
		const maxHits: number = 3; // Max 3 hits per window
		// Create a time-based bucket (5-minute buckets)
		const bucketSize = 5 * 60; // 5 minutes
		const bucketId = Math.floor(Date.now() / (bucketSize * 1000));

		// Create a compact key format: timestamp:site:ip_hash
		const ipHash = await hashIP(ipAddress);
		const key = `${bucketId}:${siteId}:${ipHash}`;

		// Get current count
		const count = await env.RATE_LIMIT.get(key);
		const currentCount = count ? parseInt(count) : 0;

		if (currentCount >= maxHits) {
			return false;
		}

		// Store just the count with auto-expiration
		await env.RATE_LIMIT.put(key, (currentCount + 1).toString(), {
			expirationTtl: bucketSize, // 5 minutes in seconds
		});

		return true;
	} catch (error) {
		console.error('Rate limit check failed:', error);
		return true; // Fail open if storage is unavailable
	}
}

// Hash IP to reduce key size while maintaining privacy
async function hashIP(ip: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(ip);
	const hashBuffer = await crypto.subtle.digest('SHA-1', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	// Take first 4 bytes of hash (8 hex chars)
	return hashArray
		.slice(0, 4)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// Referrer mapping with categories
const REFERRER_MAPPINGS: Record<string, { name: string; category: string }> = {
	// Social Media
	't.co': { name: 'Twitter', category: 'social' },
	'x.com': { name: 'Twitter', category: 'social' },
	'twitter.com': { name: 'Twitter', category: 'social' },
	'l.facebook.com': { name: 'Facebook', category: 'social' },
	'facebook.com': { name: 'Facebook', category: 'social' },
	'fb.me': { name: 'Facebook', category: 'social' },
	'lnkd.in': { name: 'LinkedIn', category: 'social' },
	'linkedin.com': { name: 'LinkedIn', category: 'social' },
	'instagram.com': { name: 'Instagram', category: 'social' },

	// Search Engines
	'google.com': { name: 'Google', category: 'search' },
	'bing.com': { name: 'Bing', category: 'search' },
	'duckduckgo.com': { name: 'DuckDuckGo', category: 'search' },
	'baidu.com': { name: 'Baidu', category: 'search' },
	'yandex.ru': { name: 'Yandex', category: 'search' },

	// URL Shorteners
	'bit.ly': { name: 'Bitly', category: 'shortener' },
	'goo.gl': { name: 'Google', category: 'shortener' },
	'tinyurl.com': { name: 'TinyURL', category: 'shortener' },
	'ow.ly': { name: 'Hootsuite', category: 'shortener' },
	'buff.ly': { name: 'Buffer', category: 'shortener' },

	// Other Social/Community
	'reddit.com': { name: 'Reddit', category: 'community' },
	'hackernews.com': { name: 'Hacker News', category: 'community' },
	'news.ycombinator.com': { name: 'Hacker News', category: 'community' },
	'producthunt.com': { name: 'Product Hunt', category: 'community' },
	'medium.com': { name: 'Medium', category: 'community' },
	'dev.to': { name: 'Dev.to', category: 'community' },

	// Email Services
	'mail.google.com': { name: 'Gmail', category: 'email' },
	'outlook.live.com': { name: 'Outlook', category: 'email' },
	'outlook.office.com': { name: 'Outlook', category: 'email' },
	'mail.yahoo.com': { name: 'Yahoo Mail', category: 'email' },
};

export function getNormalizedReferrer(referer: string): string {
	try {
		const url = new URL(referer);
		const domain = url.hostname;
		// Check if this is a known shortener/service domain
		return REFERRER_MAPPINGS[domain]?.name || domain;
	} catch {
		return 'direct'; // Invalid URL
	}
}

export const getHashedIp = async (ip: string) => {
	const encoder = new TextEncoder();
	const data = encoder.encode(ip);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
};
