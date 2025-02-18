import { Context } from 'hono';
import { createClient } from '@supabase/supabase-js';

export const validateResponse = async (c: Context, html: string, domain: string, cid: string) => {
	// Normalize input
	const normalizedContent = html.toLowerCase();

	// Define suspicious patterns
	const patterns = {
		// Login form patterns
		loginForms:
			/<form[^>]*>(?:[^<]*(?:<(?!\/form)[^<]*)*)?(?:<input[^>]*(?:password|login|username)[^>]*>)(?:[^<]*(?:<(?!\/form)[^<]*)*)?<\/form>/i,

		// Suspicious URLs and domains
		suspiciousUrls: [
			/href=["'](?!https:\/\/(?:[\w-]+\.)*(?:paypal\.com|google\.com|microsoft\.com|apple\.com)\/)[^"']*(?:login|account|signin|security|verify)/i,
			/(?:paypal|google|microsoft|apple|amazon)(?!(?:\.com|\.net|\.org))/i,
			/\b(?:\.tk|\.xyz|\.top)\b/i,
		],

		// Data collection patterns
		sensitiveDataFields: [
			/(?:<input[^>]*type=["'](?:password|tel|card|credit|ssn|social)[^>]*>)/i,
			/\b(?:ssn|social security|credit card|cvv|password)\b/i,
		],

		// Deceptive content patterns
		urgencyPatterns: [
			/\b(?:urgent|immediate|limited time|account.*?suspend|verify.*?account|security.*?breach)\b/i,
			/(?:24 hours|account.*?locked|unusual.*?activity)/i,
		],

		// Obfuscation patterns
		obfuscation: [
			/eval\s*\(/i,
			/document\.write\s*\(/i,
			/(?:unescape|escape|decodeURIComponent)\s*\(/i,
			/base64[^)]*\)/i,
			/<script[^>]*>[^<]*(?:\\x[0-9a-f]{2}|\\u[0-9a-f]{4})[^<]*<\/script>/i,
		],

		// Hidden content patterns
		hiddenContent: [/<[^>]+style=["'][^"']*(?:display:\s*none|visibility:\s*hidden|opacity:\s*0)[^"']*["']/i, /<div[^>]*hidden[^>]*>/i],
	};

	// Initialize results object
	const results: any = {
		riskLevel: 'low',
		detectedPatterns: [],
		details: {},
	};

	// Check for login forms
	if (patterns.loginForms.test(normalizedContent)) {
		results.detectedPatterns.push('login_form_present');
		results.details.loginForm = true;
	}

	// Check suspicious URLs
	patterns.suspiciousUrls.forEach((pattern, index) => {
		if (pattern.test(normalizedContent)) {
			results.detectedPatterns.push('suspicious_url');
			results.details.suspiciousUrls = true;
		}
	});

	// Check sensitive data collection
	patterns.sensitiveDataFields.forEach((pattern, index) => {
		if (pattern.test(normalizedContent)) {
			results.detectedPatterns.push('sensitive_data_collection');
			results.details.sensitiveData = true;
		}
	});

	// Check urgency patterns
	patterns.urgencyPatterns.forEach((pattern, index) => {
		if (pattern.test(normalizedContent)) {
			results.detectedPatterns.push('urgency_language');
			results.details.urgencyLanguage = true;
		}
	});

	// Check obfuscation
	patterns.obfuscation.forEach((pattern, index) => {
		if (pattern.test(normalizedContent)) {
			results.detectedPatterns.push('obfuscated_content');
			results.details.obfuscation = true;
		}
	});

	// Check hidden content
	patterns.hiddenContent.forEach((pattern, index) => {
		if (pattern.test(normalizedContent)) {
			results.detectedPatterns.push('hidden_content');
			results.details.hiddenContent = true;
		}
	});

	// Calculate risk level
	const riskScore = results.detectedPatterns.length;
	console.log({ riskScore });
	if (riskScore >= 2) {
		try {
			const message = `Potential malicious content from (Risk Score ${riskScore}): https://${domain}.orbiter.website`;
			await fetch('https://slack.com/api/chat.postMessage', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${c.env.SLACK_TOKEN}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					channel: c.env.SLACK_CHANNEL_ID,
					text: message,
				}),
			});

			const supabase = createClient('https://myyfwiyflnerjrdaoyxs.supabase.co', c.env.SUPABASE_SERVICE_ROLE_KEY);

			const { data, error } = await supabase
				.from('bad_content')
				.insert([{ domain: `https://${domain}.orbiter.website`, cid }])
				.select();

			if (error) {
				console.log(error)
			}
		} catch (error) {
			console.log('Error posting to slack or database');
			console.log(error);
		}
	}
};
