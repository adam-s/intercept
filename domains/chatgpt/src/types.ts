/**
 * ChatGPT domain types.
 *
 * Defines all ChatGPT-specific API shapes and fingerprint profile types.
 * Fingerprint types live here (domain-specific — used only by the ChatGPT proxy).
 */

// ─── Fingerprint Profile ──────────────────────────────────────────────────────
// All 55 properties that Cloudflare Turnstile / ChatGPT Sentinel reads.
// Based on Buchodi's bytecode analysis of the Turnstile VM.

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
 *  Turnstile creates a hidden div, sets a font, calls getBoundingClientRect. */
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

/** Controls the 36 window.__oai_so_* behavioral biometric properties that
 *  ChatGPT's Signal Orchestrator monitors. */
export interface BehavioralFingerprint {
	keystrokeIntervalMs?: number;
	keystrokeCount?: number;
	mouseVelocity?: number;
	mouseDistancePx?: number;
	scrollCount?: number;
	scrollDistancePx?: number;
	idleMs?: number;
	pasteCount?: number;
	clickCount?: number;
}

/** Controls what the fingerprint program sees when it reads ChatGPT's React internals. */
export interface ApplicationStateFingerprint {
	reactRouterContextPresent?: boolean;
	loaderDataPresent?: boolean;
	clientBootstrapPresent?: boolean;
}

export interface FingerprintProfile {
	/** Human-readable name for this profile */
	name: string;
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

// ─── Chat API ────────────────────────────────────────────────────────────────

export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: {
		content_type: 'text';
		parts: string[];
	};
}

/**
 * Body accepted by POST /api/chatgpt/chat
 */
export interface ChatRequest {
	message: string;
	model?: string;
	conversationId?: string;
	parentMessageId?: string;
}

/**
 * Parsed delta event from ChatGPT's backend-api/conversation SSE stream.
 * The raw stream sends `data: <json>` lines; we forward them as-is so the
 * client can handle whatever shape OpenAI returns.
 */
export type ChatStreamEvent = Record<string, unknown>;

// ─── Session ────────────────────────────────────────────────────────────────

export interface ChatGPTSessionStatus {
	connected: boolean;
	email?: string;
	tokenAgeMs?: number;
	needsRefresh: boolean;
}

// ─── Fingerprint interceptor ─────────────────────────────────────────────────

export type ChatGPTInterceptorMode = 'log' | 'control';

export interface FingerprintLogEntry {
	timestamp: number;
	/** Which layer: 'browser' | 'behavioral' | 'app_state' */
	layer: string;
	/** Property name e.g. 'UNMASKED_RENDERER_WEBGL', '__reactRouterContext' */
	property: string;
	/** Value that was read (or would have been sent) */
	value: unknown;
	/** Source frame URL */
	frameUrl?: string;
}
