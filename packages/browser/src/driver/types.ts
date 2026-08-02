/**
 * Browser Driver Contract
 *
 * The seam between "what this framework needs from a browser" and "which
 * browser is providing it."
 *
 * The framework grew up on Chromium via Patchright and reached for CDP wherever
 * it was convenient. CDP is Chromium-only: Firefox speaks Juggler, and
 * Playwright exposes no CDP session for it. So every capability expressed as a
 * CDP call is a capability that binds the framework to one engine.
 *
 * This interface is deliberately protocol-agnostic. Everything on it can be
 * implemented on any Playwright-compatible engine:
 *
 *  - Navigation and page evaluation are already engine-neutral.
 *  - Traffic capture uses `page.on('request'|'response')`, not CDP
 *    `Network.*` events.
 *  - Fingerprint control is *not* on this interface, because the two engines
 *    solve it at different layers and pretending otherwise would produce a
 *    lowest-common-denominator API that serves neither. Chromium spoofs from
 *    JavaScript over CDP; Camoufox sets it in C++ below the reach of any page
 *    script, configured at launch. A driver declares what it supports through
 *    `capabilities`, and a caller that needs a capability checks for it rather
 *    than discovering its absence at runtime.
 *
 * Adding a driver is implementing this interface. It is never a refactor of the
 * callers, which is the property that makes the second engine cheap.
 *
 * @module browser/driver/types
 */

/** Which engine backs a driver. */
export type DriverKind = 'patchright' | 'camoufox';

/**
 * What a driver can do beyond the baseline every driver must provide.
 *
 * A caller checks a capability instead of assuming it. An unsupported
 * capability is a clear, early failure rather than a silent no-op.
 */
export interface DriverCapabilities {
	/** A raw CDP session is reachable. Chromium only. */
	cdp: boolean;
	/** Fingerprint is controlled at the engine level, below page-script reach. */
	engineLevelFingerprint: boolean;
	/** The persona's reported OS can be pinned across launches. */
	pinnableOs: boolean;
	/** True headless is available. Both engines support it; not both should use it. */
	trueHeadless: boolean;
	/**
	 * `page.evaluate` runs in an isolated world that cannot see page globals.
	 *
	 * The quietest difference between the engines, and the one most likely to
	 * produce a wrong answer rather than an error. Patchright evaluates in an
	 * isolated world — verified empirically 2026-07-28 — so reading
	 * `window.__INITIAL_STATE__` returns `undefined` with nothing thrown.
	 * Firefox under Playwright evaluates in the page's own world, where the same
	 * call works. Code that must behave identically on both goes through
	 * `evaluateInMainWorld`, which is correct on either.
	 */
	isolatedEvaluateWorld: boolean;
}

/** A captured request, as the framework models one. */
export interface CapturedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

/** A captured response, as the framework models one. */
export interface CapturedResponse {
	url: string;
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

/** Called once per captured request/response pair. */
export type NetworkCaptureCallback = (req: CapturedRequest, res: CapturedResponse) => void;

/** Launch settings that differ per target, not per engine. */
export interface DriverLaunchOptions {
	/**
	 * Directory for a persistent profile, or null for a fresh ephemeral one.
	 *
	 * This is a per-target choice, not a global default. A Cloudflare-gated
	 * origin needs persistence, because its clearance cookie is bound to the
	 * fingerprint that earned it and a fresh persona invalidates it. A flagged
	 * DataDome session needs the opposite: a fresh persona *is* the recovery.
	 * Same knob, opposite settings, which is why it lives in a domain's config.
	 */
	profileDir?: string | null;

	/**
	 * Run without a visible window.
	 *
	 * Drivers whose engine is detectable in true headless refuse this and say
	 * so, rather than running in a mode that reliably trips a bot wall.
	 */
	headless?: boolean;

	/**
	 * Persona OS to report, pinned across launches.
	 *
	 * Load-bearing where a clearance cookie is bound to the user agent: an
	 * engine that randomizes persona OS per launch silently invalidates the
	 * saved cookie and re-challenges every time. Pinning it stops the challenge
	 * from firing at all, which beats solving it.
	 */
	os?: 'windows' | 'macos' | 'linux';

	/** Extra engine arguments. Engine-specific by nature; used sparingly. */
	args?: string[];

	/** Milliseconds to wait for the engine to start. */
	timeout?: number;
}

/** The page surface the framework uses. Structural, so both engines satisfy it. */
export interface DriverPage {
	goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
	evaluate<R, A>(fn: (arg: A) => R, arg?: A): Promise<R>;
	content(): Promise<string>;
	url(): string;
	close(): Promise<void>;
	on(event: string, handler: (...args: never[]) => void): void;
	screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
}

/**
 * A launched browser, engine-agnostic.
 *
 * `startTrafficCapture` returns a stop function rather than taking a matching
 * `stopTrafficCapture`, so a caller cannot leak a listener by forgetting the
 * second half of a pair.
 */
export interface DriverSession {
	readonly kind: DriverKind;
	readonly capabilities: DriverCapabilities;
	newPage(): Promise<DriverPage>;
	startTrafficCapture(page: DriverPage, onCapture: NetworkCaptureCallback): Promise<() => void>;
	close(): Promise<void>;
}

/** Launches sessions for one engine. */
export interface BrowserDriver {
	readonly kind: DriverKind;
	readonly capabilities: DriverCapabilities;
	/** Whether this engine is installed and usable, with the reason when it is not. */
	isAvailable(): Promise<{ available: boolean; reason?: string }>;
	launch(options?: DriverLaunchOptions): Promise<DriverSession>;
}

/** Raised when a caller asks a driver for something its engine cannot do. */
export class DriverCapabilityError extends Error {
	constructor(
		readonly kind: DriverKind,
		readonly capability: keyof DriverCapabilities,
		detail: string,
	) {
		super(`The ${kind} driver does not support "${capability}": ${detail}`);
		this.name = 'DriverCapabilityError';
	}
}
