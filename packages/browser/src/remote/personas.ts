/**
 * Per-profile personas for the browser pool. Each pool browser gets a
 * distinct fingerprint surface (UA, screen, languages, timezone, WebGL)
 * so chatgpt's anti-abuse layer sees them as different "devices".
 *
 * Type is structurally compatible with `chatgpt/types.FingerprintProfile`
 * — duplicated locally so the browser/ tree stays free of chatgpt/ imports.
 */

export interface PoolPersona {
	name: string;
	userAgent: string;
	languages: string[];
	language: string;
	timezone: string;
	browser: {
		hardware: {
			platform: string;
			hardwareConcurrency: number;
			deviceMemory?: number;
			vendor: string;
		};
		screen: {
			width: number;
			height: number;
			colorDepth: number;
			availWidth: number;
			availHeight: number;
		};
		webgl: {
			vendor: string;
			renderer: string;
		};
	};
}

/**
 * A small, deliberately-varied set of personas drawn from realistic
 * desktop combinations. Six is enough to comfortably feed POOL_SIZE up
 * to 6; for larger pools we'd cycle or generate procedurally.
 */
export const PERSONAS: PoolPersona[] = [
	{
		name: 'mac-chrome-en',
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		languages: ['en-US', 'en'],
		language: 'en-US',
		timezone: 'America/New_York',
		browser: {
			hardware: {
				platform: 'MacIntel',
				hardwareConcurrency: 12,
				deviceMemory: 16,
				vendor: 'Google Inc.',
			},
			screen: { width: 1280, height: 800, colorDepth: 24, availWidth: 1280, availHeight: 776 },
			webgl: { vendor: 'Apple Inc.', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
		},
	},
	{
		name: 'win-chrome-en',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		languages: ['en-US', 'en'],
		language: 'en-US',
		timezone: 'America/Chicago',
		browser: {
			hardware: {
				platform: 'Win32',
				hardwareConcurrency: 8,
				deviceMemory: 16,
				vendor: 'Google Inc.',
			},
			screen: { width: 1920, height: 1080, colorDepth: 24, availWidth: 1920, availHeight: 1040 },
			webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA GeForce RTX 3060)' },
		},
	},
	{
		name: 'mac-chrome-en-gb',
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		languages: ['en-GB', 'en'],
		language: 'en-GB',
		timezone: 'Europe/London',
		browser: {
			hardware: {
				platform: 'MacIntel',
				hardwareConcurrency: 8,
				deviceMemory: 8,
				vendor: 'Google Inc.',
			},
			screen: { width: 1440, height: 900, colorDepth: 30, availWidth: 1440, availHeight: 877 },
			webgl: { vendor: 'Apple Inc.', renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)' },
		},
	},
	{
		name: 'win-chrome-de',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		languages: ['de-DE', 'de', 'en'],
		language: 'de-DE',
		timezone: 'Europe/Berlin',
		browser: {
			hardware: {
				platform: 'Win32',
				hardwareConcurrency: 16,
				deviceMemory: 32,
				vendor: 'Google Inc.',
			},
			screen: { width: 2560, height: 1440, colorDepth: 24, availWidth: 2560, availHeight: 1400 },
			webgl: { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD Radeon RX 6800)' },
		},
	},
	{
		name: 'mac-chrome-fr',
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		languages: ['fr-FR', 'fr', 'en'],
		language: 'fr-FR',
		timezone: 'Europe/Paris',
		browser: {
			hardware: {
				platform: 'MacIntel',
				hardwareConcurrency: 10,
				deviceMemory: 16,
				vendor: 'Google Inc.',
			},
			screen: { width: 1512, height: 982, colorDepth: 24, availWidth: 1512, availHeight: 949 },
			webgl: { vendor: 'Apple Inc.', renderer: 'ANGLE (Apple, Apple M2 Pro, OpenGL 4.1)' },
		},
	},
	{
		name: 'win-chrome-jp',
		userAgent:
			'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
		languages: ['ja-JP', 'ja', 'en'],
		language: 'ja-JP',
		timezone: 'Asia/Tokyo',
		browser: {
			hardware: {
				platform: 'Win32',
				hardwareConcurrency: 12,
				deviceMemory: 16,
				vendor: 'Google Inc.',
			},
			screen: { width: 1920, height: 1200, colorDepth: 24, availWidth: 1920, availHeight: 1160 },
			webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel UHD Graphics 770)' },
		},
	},
];

/** Pick the i-th persona, cycling. */
export function pickPersona(index: number): PoolPersona {
	return PERSONAS[index % PERSONAS.length];
}
