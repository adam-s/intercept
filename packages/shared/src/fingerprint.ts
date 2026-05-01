/**
 * FingerprintProfile — every surface that Cloudflare Turnstile / ChatGPT Sentinel
 * reads about your browser. Based on Buchodi's 55-property analysis of the
 * Turnstile bytecode (https://www.buchodi.com/chatgpt-wont-let-you-type-until-cloudflare-reads-your-react-state-i-decrypted-the-program-that-does-it/).
 *
 * All fields are optional — missing fields fall through to the real browser value.
 */

// ---------------------------------------------------------------------------
// Layer 1: Browser Fingerprint
// ---------------------------------------------------------------------------

export interface WebGLFingerprint {
	/** UNMASKED_VENDOR_WEBGL (param 37445) e.g. "Apple Inc." */
	vendor: string;
	/** UNMASKED_RENDERER_WEBGL (param 37446) e.g. "Apple M2" */
	renderer: string;
	/** VERSION (param 7938) */
	version?: string;
	/** SHADING_LANGUAGE_VERSION (param 35724) */
	shadingLanguageVersion?: string;
}

export interface ScreenFingerprint {
	colorDepth?: number;
	pixelDepth?: number;
	width?: number;
	height?: number;
	availWidth?: number;
	availHeight?: number;
	availLeft?: number;
	availTop?: number;
}

export interface HardwareFingerprint {
	hardwareConcurrency?: number;
	deviceMemory?: number;
	maxTouchPoints?: number;
	platform?: string;
	vendor?: string;
}

/** Map of font family → measured bounding rect dimensions.
 *  Turnstile creates a hidden div, sets a font, calls getBoundingClientRect,
 *  then removes the element. Return controlled dimensions here. */
export interface FontMeasurements {
	[fontFamily: string]: { width: number; height: number };
}

export interface BrowserFingerprint {
	webgl?: WebGLFingerprint;
	screen?: ScreenFingerprint;
	hardware?: HardwareFingerprint;
	/** Fake plugin list. Set to [] for "no plugins" or omit to use defaults. */
	plugins?: Array<{ name: string; filename: string; description: string }>;
	fonts?: FontMeasurements;
}

// ---------------------------------------------------------------------------
// Layer 2: Behavioral Biometrics (Signal Orchestrator / window.__oai_so_*)
// ---------------------------------------------------------------------------

/** Controls the 36 window.__oai_so_* behavioral biometric properties that
 *  ChatGPT's Signal Orchestrator monitors. Pass realistic values to appear
 *  human, or omit to use the interceptor's synthetic defaults. */
export interface BehavioralFingerprint {
	/** Average time between keystrokes in ms (realistic: 80–200) */
	keystrokeIntervalMs?: number;
	/** Number of keystrokes to pre-seed */
	keystrokeCount?: number;
	/** Mouse velocity in px/ms (realistic: 0.3–1.2) */
	mouseVelocity?: number;
	/** Total mouse movement distance in px */
	mouseDistancePx?: number;
	/** Scroll event count */
	scrollCount?: number;
	/** Total scroll distance in px */
	scrollDistancePx?: number;
	/** Idle time in ms before first interaction */
	idleMs?: number;
	/** Number of paste events */
	pasteCount?: number;
	/** Click count */
	clickCount?: number;
}

// ---------------------------------------------------------------------------
// Layer 3: Application State (React / ChatGPT-specific)
// ---------------------------------------------------------------------------

/** Controls what the fingerprint program sees when it reads ChatGPT's React
 *  internals. These properties only exist when the full SPA has hydrated. */
export interface ApplicationStateFingerprint {
	/** Whether __reactRouterContext should appear present */
	reactRouterContextPresent?: boolean;
	/** Whether loaderData should appear present */
	loaderDataPresent?: boolean;
	/** Whether clientBootstrap should appear present */
	clientBootstrapPresent?: boolean;
}

// ---------------------------------------------------------------------------
// Root profile
// ---------------------------------------------------------------------------

export interface FingerprintProfile {
	/** Human-readable name for this profile */
	name: string;
	/** Optional description */
	description?: string;
	browser?: BrowserFingerprint;
	behavioral?: BehavioralFingerprint;
	applicationState?: ApplicationStateFingerprint;
	/** screenX/screenY offset added to CDP mouse events (realistic: 600–1400, 200–800) */
	screenOffsetX?: number;
	screenOffsetY?: number;
	/** User agent string */
	userAgent?: string;
	/** navigator.languages */
	languages?: string[];
	/** IANA timezone e.g. "America/New_York" */
	timezone?: string;
	/** navigator.language */
	language?: string;
}
