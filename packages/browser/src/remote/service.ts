/**
 * Remote Browser Streaming Service
 *
 * Provides screenshot-based streaming of a Patchright browser session.
 * Uses Patchright's native methods for input handling.
 *
 * Anti-detection (Patchright best practices):
 * - Uses Chromium browser for ARM64 compatibility
 * - Uses launchPersistentContext for better fingerprinting
 * - Consistent Mac User-Agent and fingerprint across all platforms
 * - headless: false for best bypass (new headless mode still detectable)
 * - Blocks fingerprinting/tracking scripts (FingerprintJS, Segment, etc.)
 *
 * @module browser/remote
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FingerprintProfile } from '@interceptor/shared';
import type { BrowserContext, CDPSession, Page, Route } from 'patchright';
import { chromium } from 'patchright';
import { BlockerManager } from '../blocker';
import type {
	CDPLoadingFailed,
	CDPLoadingFinished,
	CDPRequestWillBeSent,
	CDPResponseReceived,
	CDPWebSocketClosed,
	CDPWebSocketCreated,
	CDPWebSocketFrameReceived,
} from './cdp-types';
import { FingerprintController } from './fingerprint-controller';

// Rate limiter integration for browserFetch — injected at startup to avoid circular deps
let rateLimitWait: ((url: string) => Promise<void>) | null = null;
let rateLimitRecord: ((url: string) => void) | null = null;
let rateLimitRelease: ((url: string) => void) | null = null;

/**
 * Connect the rate limiter to browserFetch. Called once at API server startup.
 * This avoids a circular dependency (browser ↔ shared).
 */
export function connectBrowserRateLimiter(fns: {
	wait: (url: string) => Promise<void>;
	record: (url: string) => void;
	release: (url: string) => void;
}): void {
	rateLimitWait = fns.wait;
	rateLimitRecord = fns.record;
	rateLimitRelease = fns.release;
}

export interface StreamConfig {
	/** Frames per second (default: 4) */
	fps?: number;
	/** JPEG quality 0-100 (default: 70) */
	quality?: number;
	/** Viewport width (default: 1280) */
	viewportWidth?: number;
	/** Viewport height (default: 720) */
	viewportHeight?: number;
	/** Run browser in headless mode - WARNING: easier to detect (default: false) */
	headless?: boolean;
	/** Enable Ghostery ad/tracker blocking (default: true) */
	enableAdBlocking?: boolean;
	/** Custom user data directory for persistent profiles (default: temp) */
	userDataDir?: string;
	/**
	 * Proxy type to use for connections.
	 * - 'none': Direct connection (default)
	 * - 'datacenter': Bright Data datacenter proxy (cheaper, faster, more detectable)
	 * - 'residential': Bright Data residential proxy (more expensive, slower, less detectable)
	 */
	proxyType?: 'none' | 'datacenter' | 'residential';
}

export interface FrameData {
	/** Frame sequence number */
	frameId: number;
	/** JPEG image bytes */
	bytes: Uint8Array;
	/** Capture timestamp */
	timestamp: number;
}

export type FrameCallback = (frame: FrameData) => void;
export type ErrorCallback = (error: Error) => void;
export type CrashCallback = (reason: string) => void;

const DEFAULT_CONFIG: Omit<Required<StreamConfig>, 'userDataDir'> & { userDataDir?: string } = {
	fps: 1,
	quality: 30,
	viewportWidth: 1024,
	viewportHeight: 576,
	headless: true,
	enableAdBlocking: false,
	userDataDir: undefined,
	proxyType: 'none',
};

/** Full config type with optional userDataDir */
type FullConfig = Required<Omit<StreamConfig, 'userDataDir'>> & { userDataDir?: string };

/**
 * Remote browser streaming service using Patchright.
 */
export class RemoteBrowserService {
	private config: FullConfig;
	private context: BrowserContext | null = null;
	private page: Page | null = null;
	private cdp: CDPSession | null = null;
	private frameCallback: FrameCallback | null = null;
	private urlChangeCallback: ((url: string) => void) | null = null;
	private urlChangeHandler: ((frame: unknown) => void) | null = null;
	private errorCallback: ErrorCallback | null = null;
	private crashCallback: CrashCallback | null = null;
	private frameId = 0;
	private isRunning = false;
	private userDataDir: string | null = null;
	private interceptors: Map<string, (route: Route) => Promise<void>> = new Map();

	/**
	 * Named pages for domain-specific parallel browsing.
	 * Each domain (e.g., 'domain-a', 'domain-b') gets its own page in the same context,
	 * enabling parallel navigation without clobbering. The main streaming page (this.page)
	 * remains separate — named pages are headless workers with no screencast.
	 */
	private namedPages: Map<string, Page> = new Map();

	/** Controls browser fingerprinting — anti-detection script, blocked URLs, UA, sec-ch-ua.
	 *  Recreated via setFingerprintProfile() when the active profile changes. */
	private fingerprint = new FingerprintController();

	/** Active fingerprint profile — kept so getFingerprintProfile() can return it */
	private fingerprintProfile: FingerprintProfile | undefined = undefined;

	/** Callback for CDP-captured network traffic (XHR/Fetch JSON responses) */
	private networkCaptureCallback:
		| ((
				req: { method: string; url: string; body: unknown; headers: Record<string, string> },
				res: { url: string; status: number; headers: Record<string, string>; body: unknown },
		  ) => void)
		| null = null;

	// Frame throttling state (double-buffer pattern)
	private lastFrameSentAt = 0;
	private pendingFrame: FrameData | null = null;
	private frameIntervalMs: number;

	constructor(config: StreamConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config } as FullConfig;
		// Calculate frame interval from FPS (e.g., 1 FPS = 1000ms interval)
		this.frameIntervalMs = Math.floor(1000 / this.config.fps);
	}

	/**
	 * Get proxy configuration based on proxyType setting.
	 * Parses Bright Data proxy URLs from environment variables.
	 *
	 * URL format: http://username:password@host:port
	 * - BRIGHTDATA_PROXY_URL: Datacenter proxy (cheaper, faster, more detectable)
	 * - BRIGHTDATA_RESIDENTIAL_URL: Residential proxy (expensive, slower, less detectable)
	 */
	private getProxyConfig(): { server: string; username: string; password: string } | null {
		if (this.config.proxyType === 'none') {
			return null;
		}

		const proxyUrl =
			this.config.proxyType === 'datacenter'
				? process.env.BRIGHTDATA_PROXY_URL
				: process.env.BRIGHTDATA_RESIDENTIAL_URL;

		if (!proxyUrl) {
			console.warn(
				`[RemoteBrowserService] No proxy URL found for type '${this.config.proxyType}'. ` +
					`Set BRIGHTDATA_PROXY_URL or BRIGHTDATA_RESIDENTIAL_URL in .env`,
			);
			return null;
		}

		try {
			// Parse URL format: http://username:password@host:port
			const url = new URL(proxyUrl);
			return {
				server: `${url.protocol}//${url.host}`,
				username: decodeURIComponent(url.username),
				password: decodeURIComponent(url.password),
			};
		} catch (error) {
			console.error(`[RemoteBrowserService] Failed to parse proxy URL: ${error}`);
			return null;
		}
	}

	/**
	 * Get the viewport dimensions for coordinate mapping on the client.
	 */
	getViewport(): { width: number; height: number } {
		return {
			width: this.config.viewportWidth,
			height: this.config.viewportHeight,
		};
	}

	/**
	 * Get the current FPS setting.
	 */
	getFps(): number {
		return this.config.fps;
	}

	/**
	 * Dynamically change the frame rate.
	 * Uses double-buffer pattern: only the latest frame is sent at the target rate.
	 * @param fps - Target frames per second (0.5 to 30)
	 */
	setFps(fps: number): void {
		const clampedFps = Math.max(0.5, Math.min(30, fps));
		this.config.fps = clampedFps;
		this.frameIntervalMs = Math.floor(1000 / clampedFps);
		console.log(
			`[RemoteBrowserService] FPS changed to ${clampedFps} (interval: ${this.frameIntervalMs}ms)`,
		);
	}

	/**
	 * Dynamically change the JPEG compression quality.
	 * Higher = better image, larger frames. Browserless defaults to 70.
	 * @param quality - JPEG quality (0–100)
	 */
	setQuality(quality: number): void {
		this.config.quality = Math.max(0, Math.min(100, quality));
		// Restart screencast with new quality
		void this.nudgeScreencast();
	}

	/**
	 * Capture a single screenshot and send it as a frame.
	 * Useful for guaranteeing the client sees something immediately —
	 * CDP screencast is event-driven and won't fire if the page hasn't changed.
	 */
	async captureAndSendFrame(): Promise<void> {
		if (!this.cdp || !this.frameCallback) return;
		try {
			const result = await this.cdp.send('Page.captureScreenshot', {
				format: 'jpeg',
				quality: this.config.quality,
			});
			const bytes = Buffer.from((result as { data: string }).data, 'base64');
			this.frameCallback({
				frameId: Date.now(),
				bytes,
				timestamp: Date.now(),
			});
		} catch {
			// Best-effort — don't crash if screenshot fails
		}
	}

	/**
	 * Get the current page instance for direct manipulation.
	 * Useful for attaching interceptors or running custom scripts.
	 */
	getPage(): Page | null {
		return this.page;
	}

	/**
	 * Get or create a named page for a specific domain.
	 * Named pages run in the same browser context (shared cookies, anti-detection)
	 * but navigate independently — enabling parallel browsing across domains.
	 * Pages persist between calls so the same domain reuses its tab.
	 */
	async getOrCreatePage(id: string): Promise<Page> {
		const existing = this.namedPages.get(id);
		if (existing && !existing.isClosed()) return existing;

		if (!this.context) throw new Error('Browser not running — connect via WebSocket first');
		const newPage = await this.context.newPage();

		// Apply same anti-detection as main page (context-level addInitScript
		// only applies to pages created AFTER the call, so we need page-level too)
		await this.fingerprint.applyToPage(newPage);

		// Enable ad blocking on the new page
		if (this.config.enableAdBlocking) {
			const blockerManager = BlockerManager.getInstance();
			await blockerManager.enableBlockingSilent(newPage);
		}

		this.namedPages.set(id, newPage);
		return newPage;
	}

	/**
	 * Check if the browser is currently running.
	 */
	getIsRunning(): boolean {
		return this.isRunning;
	}

	/**
	 * Register a route interceptor for capturing/modifying requests.
	 * @param pattern - URL glob pattern to intercept (e.g., '**\/api.boardshop.com\/**')
	 * @param handler - Async handler function that receives the Route
	 */
	async addInterceptor(pattern: string, handler: (route: Route) => Promise<void>): Promise<void> {
		if (!this.page) {
			throw new Error('Browser not started - cannot add interceptor');
		}
		if (this.interceptors.has(pattern)) {
			console.log(`[RemoteBrowserService.addInterceptor] Pattern already registered: ${pattern}`);
			return;
		}
		await this.page.route(pattern, handler);
		this.interceptors.set(pattern, handler);
		console.log(`[RemoteBrowserService.addInterceptor] Registered interceptor for: ${pattern}`);
	}

	/**
	 * Remove a previously registered route interceptor.
	 */
	async removeInterceptor(pattern: string): Promise<void> {
		if (!this.page) return;
		if (!this.interceptors.has(pattern)) return;

		await this.page.unroute(pattern);
		this.interceptors.delete(pattern);
		console.log(`[RemoteBrowserService.removeInterceptor] Removed interceptor for: ${pattern}`);
	}

	/**
	 * Remove all registered interceptors.
	 */
	async clearInterceptors(): Promise<void> {
		if (!this.page) return;

		for (const pattern of this.interceptors.keys()) {
			await this.page.unroute(pattern);
		}
		this.interceptors.clear();
		console.log('[RemoteBrowserService.clearInterceptors] Cleared all interceptors');
	}

	/**
	 * Set or replace the active fingerprint profile.
	 * If the browser is already running, restarts the init script on the current page.
	 * Note: a full browser restart (stop + start) is needed for context-level init script changes.
	 */
	async setFingerprintProfile(profile: FingerprintProfile | undefined): Promise<void> {
		this.fingerprintProfile = profile;
		this.fingerprint = new FingerprintController(profile);
		if (this.page) {
			// Re-apply init script to the current page so the new profile is active on next navigation.
			// A full stop+start is needed for context-level changes to take full effect.
			await this.fingerprint.applyToPage(this.page);
			console.log(
				`[RemoteBrowserService.setFingerprintProfile] Applied profile: ${profile?.name ?? 'default'}`,
			);
		}
	}

	/** Return the currently active fingerprint profile (undefined = built-in defaults). */
	getFingerprintProfile(): FingerprintProfile | undefined {
		return this.fingerprintProfile;
	}

	/**
	 * Start the browser and begin streaming frames.
	 */
	async start(
		onFrame: FrameCallback,
		options?: { onError?: ErrorCallback; onCrash?: CrashCallback },
	): Promise<void> {
		if (this.isRunning) {
			console.log('[RemoteBrowserService.start] Already running, skipping start');
			return;
		}

		console.log('[RemoteBrowserService.start] Starting browser...');
		this.frameCallback = onFrame;
		this.errorCallback = options?.onError ?? null;
		this.crashCallback = options?.onCrash ?? null;
		this.isRunning = true;

		try {
			await this.launchBrowser();
			console.log('[RemoteBrowserService.start] Browser started successfully');
		} catch (err) {
			console.error('[RemoteBrowserService.start] Failed to start browser:', err);
			// Reset state so we can try again
			this.isRunning = false;
			this.context = null;
			this.page = null;
			this.cdp = null;
			this.frameCallback = null;
			this.errorCallback = null;
			this.crashCallback = null;
			throw err;
		}
	}

	/**
	 * Internal method to launch browser - separated for error handling.
	 */
	private async launchBrowser(): Promise<void> {
		// Use provided userDataDir (persistent profile) or create temp
		if (this.config.userDataDir) {
			this.userDataDir = this.config.userDataDir;
		} else {
			this.userDataDir = mkdtempSync(join(tmpdir(), 'patchright-'));
		}

		// ⚠️  ANTI-DETECTION ARGS — do not remove or reorder without testing against bot-protected sites.
		// Each flag prevents a specific detection vector. Removing any one can break all browser-dependent routes.
		const commonArgs = [
			'--disable-infobars',
			'--disable-blink-features=AutomationControlled', // hides navigator.webdriver from JS
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
			// Prevents GPU process crash loop in headless/container environments without
			// GPU hardware. Falls back to Skia CPU rendering (sufficient for screenshots
			// and CDP screencasting). Harmless on macOS where real GPU is available.
			'--disable-gpu',
		];

		// SwiftShader provides software WebGL on Linux/Docker without a real GPU.
		// On macOS (darwin) the real GPU handles WebGL natively — SwiftShader
		// conflicts and disables WebGL entirely.
		if (process.platform === 'linux') {
			commonArgs.push('--use-gl=swiftshader', '--use-angle=swiftshader-webgl');
		}

		// When using a persistent Chrome user data dir, force the Default profile.
		// Without this, Chromium can sometimes spin up a fresh profile with empty cookies/storage.
		if (this.config.userDataDir) {
			commonArgs.push('--profile-directory=Default');
			commonArgs.push('--no-first-run');
			commonArgs.push('--no-default-browser-check');
		}

		// Use system Chrome/Chromium if available (Docker sets CHROME_PATH or CHROMIUM_PATH).
		// Only use the path if the binary actually exists — avoids crash when both env vars
		// are set but only one binary is installed (e.g., arm64 has Chromium but not Chrome).
		const { existsSync } = await import('node:fs');
		const chromePath =
			process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)
				? process.env.CHROME_PATH
				: undefined;
		const chromiumPath =
			process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)
				? process.env.CHROMIUM_PATH
				: undefined;
		const executablePath = chromePath || chromiumPath || undefined;

		// Configure proxy based on proxyType setting
		// Bright Data proxy URLs from environment variables
		const proxyConfig = this.getProxyConfig();
		if (proxyConfig) {
			console.log(
				`[RemoteBrowserService] Using ${this.config.proxyType} proxy: ${proxyConfig.server}`,
			);
		} else {
			console.log('[RemoteBrowserService] No proxy configured (direct connection)');
		}

		// Use real Chrome channel when available — it has window.chrome, proper plugins,
		// and real WebGL contexts that Patchright's bundled Chromium lacks.
		// Fall back to bundled Chromium when CHROMIUM_PATH is set (Docker) or Chrome isn't installed.
		const useChannel = !executablePath ? 'chrome' : undefined;

		this.context = await chromium.launchPersistentContext(this.userDataDir, {
			...(executablePath && { executablePath }),
			...(useChannel && { channel: useChannel }),
			headless: this.config.headless,
			viewport: {
				width: this.config.viewportWidth,
				height: this.config.viewportHeight,
			},
			deviceScaleFactor: 1, // Force 1x scale for consistent streaming
			userAgent: this.fingerprint.userAgent,
			locale: 'en-US',
			timezoneId: 'America/New_York',
			args: commonArgs,
			// ⚠️  DO NOT REMOVE. --enable-automation sets navigator.webdriver=true and shows
			// an automation infobar — both are primary bot detection signals. Without this
			// line, every bot-protected site (Cloudflare, PerimeterX, etc.) blocks the browser.
			// DO NOT add --disable-extensions here — Ghostery extension needs it.
			ignoreDefaultArgs: ['--enable-automation'],
			// Add proxy config if specified
			...(proxyConfig && { proxy: proxyConfig }),
			// Ignore HTTPS errors when using residential proxies (they use MITM for SSL)
			ignoreHTTPSErrors: this.config.proxyType === 'residential',
		});

		// Apply all fingerprint protections: init script, sec-ch-ua headers, and tracking URL blocklist.
		// Must run BEFORE pages are opened so the init script fires on the first page load.
		await this.fingerprint.applyToContext(this.context);

		const pages = this.context.pages();
		this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

		// Also apply init script directly to existing pages from a persistent context.
		// context.addInitScript only applies to pages created AFTER the call.
		await this.fingerprint.applyToPage(this.page);

		// Block static resources — discovery only needs HTML + JS, not images/CSS/fonts.
		// Saves ~30% memory per browser instance and speeds up page loads.
		await this.context.route(
			'**/*.{png,jpg,jpeg,gif,svg,webp,ico,css,woff,woff2,ttf,eot,mp4,webm,ogg,mp3,wav}',
			(route) => route.abort(),
		);

		// Enable Ghostery ad/tracker blocking (general ad blocking)
		if (this.config.enableAdBlocking) {
			const blockerManager = BlockerManager.getInstance();
			await blockerManager.enableBlockingSilent(this.page);
		}

		this.context.on('page', async (newPage) => {
			// Enable ad blocking on new pages too
			if (this.config.enableAdBlocking) {
				const blockerManager = BlockerManager.getInstance();
				await blockerManager.enableBlockingSilent(newPage);
			}
			try {
				await newPage.waitForLoadState('domcontentloaded', { timeout: 5000 });
			} catch {
				// Timeout is fine
			}
			await this.switchPage(newPage);
		});

		this.context.on('close', () => {
			this.handleCrash('Browser context closed');
		});

		this.page.on('crash', () => {
			this.handleCrash('Page crashed');
		});

		this.page.on('close', () => {
			if (this.isRunning && this.context) {
				const pages = this.context.pages();
				if (pages.length > 0) {
					void this.switchPage(pages[0]);
				} else {
					this.handleCrash('All pages closed');
				}
			}
		});

		// Navigate to a real page to trigger init scripts (about:blank doesn't run them)
		// We use data URL which is fast and triggers init script execution
		await this.page.goto('data:text/html,<html></html>');

		// Log browser fingerprint data for debugging bot detection issues
		await this.fingerprint.logFingerprint(this.page);

		await this.startScreencast();
	}

	/**
	 * Sites to visit during warmup to build browsing history.
	 * These are popular sites that a real user might visit, helping avoid bot detection.
	 */
	private static readonly WARMUP_SITES = [
		'https://www.wikipedia.org',
		'https://www.weather.com',
		'https://www.github.com',
		'https://www.npmjs.com',
		'https://www.bbc.com',
	];

	/**
	 * Warm up the browser by visiting common sites to build history.
	 * This helps avoid bot detection by making the browser look more like a real user's.
	 *
	 * @param sitesToVisit - Number of sites to visit (default: 3)
	 * @param delayMs - Delay between sites in milliseconds (default: 2000)
	 * @returns Promise that resolves when warmup is complete
	 */
	async warmup(sitesToVisit = 3, delayMs = 2000): Promise<void> {
		if (!this.page) {
			throw new Error('Browser not started - cannot warmup');
		}

		console.log(`[RemoteBrowserService.warmup] Visiting ${sitesToVisit} sites to build history...`);

		const sites = RemoteBrowserService.WARMUP_SITES.slice(0, sitesToVisit);

		for (const site of sites) {
			try {
				console.log(`[RemoteBrowserService.warmup] Visiting ${site}...`);
				await this.page.goto(site, { waitUntil: 'domcontentloaded', timeout: 15000 });

				// Simulate some browsing behavior - scroll a bit
				await this.page.evaluate(() => {
					window.scrollBy(0, Math.random() * 300 + 100);
				});

				// Random delay between sites (adds human-like variation)
				const actualDelay = delayMs + Math.random() * 1000;
				await new Promise((resolve) => setTimeout(resolve, actualDelay));
			} catch (err) {
				// Don't fail warmup if a site doesn't load
				console.warn(`[RemoteBrowserService.warmup] Failed to load ${site}:`, err);
			}
		}

		console.log('[RemoteBrowserService.warmup] Warmup complete');
	}

	/**
	 * Stop streaming and close the browser.
	 * Performs aggressive cleanup to ensure all browser processes are terminated.
	 */
	async stop(): Promise<void> {
		console.log('[RemoteBrowserService.stop] Stopping browser...');
		this.isRunning = false;

		await this.stopScreencast();

		// Clear named pages map (pages themselves closed below with context.pages())
		this.namedPages.clear();

		// Clear CDP session first
		if (this.cdp) {
			try {
				await this.cdp.detach();
			} catch {
				// CDP may already be detached
			}
			this.cdp = null;
		}

		// Close all pages first
		if (this.context) {
			try {
				const pages = this.context.pages();
				console.log(`[RemoteBrowserService.stop] Closing ${pages.length} pages...`);
				for (const page of pages) {
					try {
						await page.close();
					} catch {
						// Page may already be closed
					}
				}
			} catch {
				// Context may be in bad state
			}
		}

		// Close the context (this should terminate the browser process)
		if (this.context) {
			try {
				console.log('[RemoteBrowserService.stop] Closing browser context...');
				await this.context.close();
				console.log('[RemoteBrowserService.stop] Browser context closed');
			} catch (err) {
				console.error('[RemoteBrowserService.stop] Error closing context:', err);
			}
			this.context = null;
			this.page = null;
		}

		this.frameCallback = null;
		this.errorCallback = null;
		this.crashCallback = null;
		this.urlChangeCallback = null;
		this.interceptors.clear();

		// Clean up temp user data dir (non-persistent profiles only).
		// Without this, each crash+restart cycle leaves a ~50MB dir in /tmp/patchright-*.
		// After 10+ cycles, file handle exhaustion prevents new browser launches.
		if (
			this.userDataDir?.includes('/tmp/patchright-') ||
			this.userDataDir?.includes('\\tmp\\patchright-')
		) {
			try {
				const { rmSync } = await import('node:fs');
				rmSync(this.userDataDir, { recursive: true, force: true });
				console.log(`[RemoteBrowserService.stop] Cleaned temp dir: ${this.userDataDir}`);
			} catch {
				// Best-effort cleanup — dir may have locked files
			}
		}

		console.log('[RemoteBrowserService.stop] Browser stopped');
	}

	/**
	 * Replace the frame callback (used when a new WS client reuses an existing browser session).
	 * Without this, the old (closed) WS callback keeps getting called and the new client gets nothing.
	 *
	 * Also nudges the page to trigger a screencast frame — without this,
	 * a new WS client on a static page would see 0 frames because
	 * CDP only fires screencastFrame on visual changes.
	 */
	setFrameCallback(callback: FrameCallback): void {
		this.frameCallback = callback;
		// Force a visual change so CDP emits a fresh screencast frame
		void this.nudgeScreencast();
	}

	/**
	 * Trigger a visual change to force CDP to emit a screencast frame.
	 * Injects a brief visual flash via DOM manipulation — does NOT navigate,
	 * which would risk closing the page and crashing the browser.
	 */
	private async nudgeScreencast(): Promise<void> {
		if (!this.page || !this.cdp) return;
		try {
			// Stop and restart the screencast to force CDP to capture a fresh frame
			await this.cdp.send('Page.stopScreencast');
			await this.cdp.send('Page.startScreencast', {
				format: 'jpeg',
				quality: this.config.quality,
				maxWidth: this.config.viewportWidth,
				maxHeight: this.config.viewportHeight,
				everyNthFrame: 1,
			});
		} catch {
			// Best-effort — don't crash if nudge fails
		}
	}

	/**
	 * Navigate to a URL.
	 */
	async navigate(url: string): Promise<void> {
		this.assertPageAvailable();
		try {
			await this.page?.goto(url, { waitUntil: 'commit', timeout: 10000 });
		} catch (err) {
			this.handleOperationError('navigate', err);
		}
	}

	/**
	 * Move mouse to coordinates.
	 */
	async mouseMove(x: number, y: number): Promise<void> {
		if (!this.page) return;

		const clampedX = Math.max(0, Math.min(x, this.config.viewportWidth));
		const clampedY = Math.max(0, Math.min(y, this.config.viewportHeight));

		try {
			await this.page.mouse.move(clampedX, clampedY);
		} catch {
			// Mouse move errors are usually transient
		}
	}

	/**
	 * Click at coordinates.
	 */
	async click(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
		if (!this.page) return;

		const clampedX = Math.max(0, Math.min(x, this.config.viewportWidth));
		const clampedY = Math.max(0, Math.min(y, this.config.viewportHeight));

		try {
			// Check for target="_blank" links first
			const linkInfo = await this.page.evaluate(
				({ x, y }) => {
					const element = document.elementFromPoint(x, y);
					if (!element) return null;
					const anchor = element.closest('a');
					if (!anchor) return null;
					return {
						href: anchor.href,
						target: anchor.target,
					};
				},
				{ x: clampedX, y: clampedY },
			);

			if (linkInfo?.href && linkInfo.target === '_blank') {
				await this.page.goto(linkInfo.href, { waitUntil: 'commit', timeout: 10000 });
				return;
			}

			// Use raw CDP Input.dispatchMouseEvent with realistic screenX/screenY.
			// Playwright's page.mouse.click() sets screenX=x, screenY=y which
			// Cloudflare Turnstile detects as bot (coordinates too small in iframes).
			if (this.cdp) {
				const cdpButton = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
				const screenX = clampedX + 800 + Math.floor(Math.random() * 200);
				const screenY = clampedY + 200 + Math.floor(Math.random() * 100);
				const clickCount = 1;

				await this.cdp.send('Input.dispatchMouseEvent', {
					type: 'mousePressed',
					x: clampedX,
					y: clampedY,
					button: cdpButton,
					clickCount,
					// @ts-expect-error -- CDP accepts these but Playwright types don't include them
					screenX,
					screenY,
				});
				await new Promise((r) => setTimeout(r, 50 + Math.random() * 80));
				await this.cdp.send('Input.dispatchMouseEvent', {
					type: 'mouseReleased',
					x: clampedX,
					y: clampedY,
					button: cdpButton,
					clickCount,
					// @ts-expect-error -- CDP accepts these but Playwright types don't include them
					screenX,
					screenY,
				});
			} else {
				await this.page.mouse.click(clampedX, clampedY, { button });
			}
		} catch (err) {
			this.handleOperationError('click', err);
		}
	}

	/**
	 * Press mouse button down (without releasing) — required for press-and-hold interactions.
	 */
	async mouseDown(
		x: number,
		y: number,
		button: 'left' | 'right' | 'middle' = 'left',
	): Promise<void> {
		if (!this.page) return;
		const clampedX = Math.max(0, Math.min(x, this.config.viewportWidth));
		const clampedY = Math.max(0, Math.min(y, this.config.viewportHeight));
		try {
			if (this.cdp) {
				const cdpButton = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
				const screenX = clampedX + 800 + Math.floor(Math.random() * 200);
				const screenY = clampedY + 200 + Math.floor(Math.random() * 100);
				await this.cdp.send('Input.dispatchMouseEvent', {
					type: 'mousePressed',
					x: clampedX,
					y: clampedY,
					button: cdpButton,
					clickCount: 1,
					// @ts-expect-error -- CDP accepts screenX/screenY
					screenX,
					screenY,
				});
			} else {
				await this.page.mouse.move(clampedX, clampedY);
				await this.page.mouse.down({ button });
			}
		} catch (err) {
			this.handleOperationError('mouseDown', err);
		}
	}

	/**
	 * Release mouse button — pair with mouseDown for press-and-hold interactions.
	 */
	async mouseUp(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
		if (!this.page) return;
		const clampedX = Math.max(0, Math.min(x, this.config.viewportWidth));
		const clampedY = Math.max(0, Math.min(y, this.config.viewportHeight));
		try {
			if (this.cdp) {
				const cdpButton = button === 'right' ? 'right' : button === 'middle' ? 'middle' : 'left';
				const screenX = clampedX + 800 + Math.floor(Math.random() * 200);
				const screenY = clampedY + 200 + Math.floor(Math.random() * 100);
				await this.cdp.send('Input.dispatchMouseEvent', {
					type: 'mouseReleased',
					x: clampedX,
					y: clampedY,
					button: cdpButton,
					clickCount: 1,
					// @ts-expect-error -- CDP accepts screenX/screenY
					screenX,
					screenY,
				});
			} else {
				await this.page.mouse.up({ button });
			}
		} catch (err) {
			this.handleOperationError('mouseUp', err);
		}
	}

	/**
	 * Double-click at coordinates.
	 */
	async doubleClick(x: number, y: number): Promise<void> {
		if (!this.page) return;

		const clampedX = Math.max(0, Math.min(x, this.config.viewportWidth));
		const clampedY = Math.max(0, Math.min(y, this.config.viewportHeight));

		try {
			await this.page.mouse.dblclick(clampedX, clampedY);
		} catch (err) {
			this.handleOperationError('doubleClick', err);
		}
	}

	/**
	 * Scroll using wheel event.
	 */
	async scroll(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
		if (!this.page) return;

		try {
			await this.page.mouse.move(x, y);
			await this.page.mouse.wheel(deltaX, deltaY);
		} catch {
			// Scroll errors are usually transient
		}
	}

	/**
	 * Type text.
	 */
	async type(text: string): Promise<void> {
		if (!this.page) return;

		try {
			await this.page.keyboard.type(text);
		} catch (err) {
			this.handleOperationError('type', err);
		}
	}

	/**
	 * Press a special key.
	 */
	async pressKey(key: string): Promise<void> {
		if (!this.page) return;

		try {
			await this.page.keyboard.press(key);
		} catch (err) {
			this.handleOperationError('pressKey', err);
		}
	}

	/**
	 * Paste text from clipboard.
	 * Inserts the text directly using keyboard.insertText() which bypasses
	 * normal keyboard events and works like a paste operation.
	 */
	async paste(text: string): Promise<void> {
		if (!this.page) return;

		try {
			await this.page.keyboard.insertText(text);
		} catch (err) {
			this.handleOperationError('paste', err);
		}
	}

	/**
	 * Copy selected text from the page.
	 * Returns the selected text, or empty string if nothing selected.
	 */
	async copy(): Promise<string> {
		if (!this.page) return '';

		try {
			const selectedText = await this.page.evaluate(() => {
				return window.getSelection()?.toString() ?? '';
			});
			return selectedText;
		} catch {
			return '';
		}
	}

	/**
	 * Go back in browser history.
	 */
	async goBack(): Promise<void> {
		if (!this.page) return;
		try {
			await this.page.goBack({ waitUntil: 'commit', timeout: 10000 });
		} catch (err) {
			this.handleOperationError('goBack', err);
		}
	}

	/**
	 * Go forward in browser history.
	 */
	async goForward(): Promise<void> {
		if (!this.page) return;
		try {
			await this.page.goForward({ waitUntil: 'commit', timeout: 10000 });
		} catch (err) {
			this.handleOperationError('goForward', err);
		}
	}

	/**
	 * Reload the current page.
	 */
	async reload(): Promise<void> {
		if (!this.page) return;
		try {
			await this.page.reload({ waitUntil: 'commit', timeout: 10000 });
		} catch (err) {
			this.handleOperationError('reload', err);
		}
	}

	/**
	 * Execute a fetch request through the browser context.
	 * This uses the browser's cookies, session, and authentication.
	 *
	 * Default behavior: navigates to the target API origin if not already there, then fetches.
	 * This ensures cookies and session state are included.
	 *
	 * Use `navigateTo` when the API is on a subdomain that allows CORS from the main site.
	 * Example: A site serves APIs on api.example.com but allows CORS from
	 * www.example.com. Navigating to the API subdomain first loses the main site session
	 * and may hit rate limits. Instead, pass `navigateTo: 'https://www.example.com'` so
	 * the browser stays on the main site and makes a credentialed cross-origin fetch.
	 *
	 * @param url - The URL to fetch
	 * @param options.navigateTo - Override the origin to navigate to before fetching.
	 *   Use when the API subdomain has CORS enabled from the main site (any cross-domain API).
	 * @returns The response data
	 */
	async browserFetch<T = unknown>(
		url: string,
		options: {
			method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
			headers?: Record<string, string>;
			body?: unknown;
			/** Navigate to this origin before fetching instead of the target API origin.
			 *  Use for cross-origin APIs where the main site has CORS access. */
			navigateTo?: string;
			/** Timeout in ms for the entire operation (navigation + fetch). Default: 20000. */
			timeout?: number;
			/** Skip rate limiting for this request. Default: false. */
			skipRateLimit?: boolean;
		} = {},
	): Promise<{ status: number; data: T; headers: Record<string, string> }> {
		if (!this.page) {
			throw new Error('Browser not started');
		}

		// Wait for rate limit slot before making the request (Chrome TLS + rate limiting)
		if (!options.skipRateLimit && rateLimitWait) {
			await rateLimitWait(url);
		}

		const timeoutMs = options.timeout ?? 20_000;

		// Record the request start for rate limiting
		if (!options.skipRateLimit && rateLimitRecord) {
			rateLimitRecord(url);
		}

		// Wrap the entire operation in a timeout so callers never hang (BUG-4: clear timer on success)
		let timeoutHandle: ReturnType<typeof setTimeout>;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(
				() => reject(new Error(`browserFetch timed out after ${timeoutMs}ms: ${url}`)),
				timeoutMs,
			);
		});

		try {
			const fetchPromise = this._browserFetchInner<T>(url, options);
			return await Promise.race([fetchPromise, timeoutPromise]);
		} finally {
			// biome-ignore lint/style/noNonNullAssertion: timeoutHandle is set before try block
			clearTimeout(timeoutHandle!);
			if (!options.skipRateLimit && rateLimitRelease) {
				rateLimitRelease(url);
			}
		}
	}

	/** Inner implementation of browserFetch, separated to enable timeout wrapping. */
	private async _browserFetchInner<T>(
		url: string,
		options: {
			method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
			headers?: Record<string, string>;
			body?: unknown;
			navigateTo?: string;
			timeout?: number;
		},
	): Promise<{ status: number; data: T; headers: Record<string, string> }> {
		// this.page is guaranteed non-null — caller (browserFetch) checks before calling
		// biome-ignore lint/style/noNonNullAssertion: guarded by browserFetch
		const page = this.page!;

		// Extract the origin from the target URL
		const targetOrigin = new URL(url).origin;
		const currentUrl = page.url();
		let currentOrigin = '';
		try {
			currentOrigin = currentUrl ? new URL(currentUrl).origin : '';
		} catch {
			// data: URLs, about:blank, chrome-error:// don't have valid origins
		}

		// Determine navigation target: use navigateTo override if provided,
		// otherwise default to the target API origin.
		// navigateTo is used when the API subdomain has CORS enabled from the main site —
		// staying on the main site avoids navigating to a raw API endpoint that may 429
		// or lack the session context needed for credentialed requests.
		const navigationOrigin = options.navigateTo ? new URL(options.navigateTo).origin : targetOrigin;

		// Navigate to the target origin if we're not already there
		if (currentOrigin !== navigationOrigin) {
			try {
				// Navigate to a lightweight page on the target origin
				await page.goto(navigationOrigin, { waitUntil: 'domcontentloaded', timeout: 15000 });
			} catch (_err) {
				// If navigation fails, try anyway - the fetch might still work
			}
		}

		const result = await page.evaluate(
			async ({ url, options }) => {
				try {
					const fetchOptions: RequestInit = {
						method: options.method || 'GET',
						headers: {
							Accept: 'application/json',
							'Content-Type': 'application/json',
							...options.headers,
						},
						credentials: 'include', // Include cookies
					};

					if (options.body) {
						fetchOptions.body = JSON.stringify(options.body);
					}

					const response = await fetch(url, fetchOptions);

					// Collect response headers
					const responseHeaders: Record<string, string> = {};
					response.headers.forEach((value, key) => {
						responseHeaders[key] = value;
					});

					// Try to parse as JSON, fall back to text
					let data: unknown;
					const contentType = response.headers.get('content-type') || '';
					if (contentType.includes('application/json')) {
						data = await response.json();
					} else {
						data = await response.text();
					}

					return {
						success: true as const,
						status: response.status,
						data,
						headers: responseHeaders,
					};
				} catch (error) {
					return {
						success: false as const,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
			{ url, options },
		);

		if (!result.success) {
			throw new Error(result.error);
		}

		return {
			status: result.status,
			data: result.data as T,
			headers: result.headers,
		};
	}

	/**
	 * Execute JavaScript in the browser page context and return the result.
	 * Useful for extracting data from SSR pages where content is rendered into the DOM
	 * rather than returned by a JSON XHR endpoint.
	 *
	 * The function is serialized and run inside the Patchright page — it has access to
	 * `document`, `window`, and all DOM APIs. It cannot reference Node.js variables.
	 *
	 * @param fn - Function to execute in browser context. Must be serializable (no closures over Node vars).
	 */
	async evaluate<T>(fn: () => T | Promise<T>): Promise<T> {
		if (!this.page) throw new Error('Browser not started');
		return this.page.evaluate(fn);
	}

	/**
	 * Navigate to a URL, wait for DOM content to load, then execute a function in page context.
	 * The canonical method for extracting data from SSR pages.
	 *
	 * Use this when:
	 * - The page renders data via server-side rendering (not XHR)
	 * - `browserFetch()` won't work because the data lives in the DOM, not a JSON endpoint
	 * - You need `window.__NEXT_DATA__`, `window.__REDUX_STATE__`, or DOM card data
	 *
	 * @param url - Full URL to navigate to (the page to extract data from)
	 * @param fn - DOM extraction function — runs after the page loads
	 * @param waitMs - Extra delay after DOMContentLoaded for JS hydration (default: 3000)
	 */
	async extractFromPage<T>(
		url: string,
		fn: () => T | Promise<T>,
		{ waitMs = 3000 }: { waitMs?: number } = {},
	): Promise<T> {
		if (!this.page) throw new Error('Browser not started');
		await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
		return this.page.evaluate(fn);
	}

	/**
	 * Get the current page URL.
	 */
	getUrl(): string {
		return this.page?.url() ?? '';
	}

	/**
	 * Register a callback for URL changes.
	 */
	onUrlChange(callback: (url: string) => void): void {
		this.urlChangeCallback = callback;
		if (!this.page) return;

		callback(this.page.url());

		// Remove previous listener to avoid duplicates (BUG-3)
		if (this.urlChangeHandler) {
			this.page.removeListener('framenavigated', this.urlChangeHandler);
		}
		this.urlChangeHandler = (frame) => {
			if (frame === this.page?.mainFrame()) {
				callback(this.page?.url() ?? '');
			}
		};
		this.page.on('framenavigated', this.urlChangeHandler);
	}

	/**
	 * Register a callback to receive captured network traffic.
	 * CDP captures ALL XHR/Fetch requests with JSON responses.
	 */
	onNetworkCapture(
		callback: (
			req: { method: string; url: string; body: unknown; headers: Record<string, string> },
			res: { url: string; status: number; headers: Record<string, string>; body: unknown },
		) => void,
	): void {
		this.networkCaptureCallback = callback;
	}

	/**
	 * Set up CDP Network event handlers for traffic capture.
	 */
	private setupNetworkCapture(): void {
		if (!this.cdp) return;

		const pendingRequests = new Map<
			string,
			{
				method: string;
				url: string;
				body: unknown;
				headers: Record<string, string>;
				timestamp: number;
			}
		>();
		const responseInfo = new Map<
			string,
			{ url: string; status: number; headers: Record<string, string>; contentType: string }
		>();

		// Track Document requests for pre-hydration HTML capture
		const documentRequests = new Map<string, { url: string }>();

		this.cdp.on('Network.requestWillBeSent', (params: CDPRequestWillBeSent) => {
			// Capture Document requests for the analyzer (pre-hydration HTML)
			if (params.type === 'Document') {
				documentRequests.set(params.requestId, { url: params.request.url });
			}
			if (!params.type || !['XHR', 'Fetch'].includes(params.type)) return;
			let body: unknown;
			try {
				if (params.request.postData) body = JSON.parse(params.request.postData);
			} catch {
				body = params.request.postData || null;
			}
			pendingRequests.set(params.requestId, {
				method: params.request.method,
				url: params.request.url,
				body,
				headers: params.request.headers,
				timestamp: Date.now(),
			});
		});

		this.cdp.on('Network.responseReceived', (params: CDPResponseReceived) => {
			if (!pendingRequests.has(params.requestId)) return;
			const ct =
				params.response.headers['content-type'] || params.response.headers['Content-Type'] || '';
			responseInfo.set(params.requestId, {
				url: params.response.url,
				status: params.response.status,
				headers: params.response.headers,
				contentType: ct,
			});
		});

		// Unified loadingFinished handler — processes both XHR/Fetch and Document requests
		this.cdp.on('Network.loadingFinished', async (params: CDPLoadingFinished) => {
			if (!this.networkCaptureCallback) return;

			// Check if this is a Document request (pre-hydration HTML capture)
			const doc = documentRequests.get(params.requestId);
			if (doc) {
				documentRequests.delete(params.requestId);
				try {
					const bodyResult = await this.cdp?.send('Network.getResponseBody', {
						requestId: params.requestId,
					});
					this.networkCaptureCallback(
						{ method: 'DOCUMENT', url: doc.url, body: null, headers: {} },
						{
							url: doc.url,
							status: 200,
							headers: { 'content-type': 'text/html' },
							body: bodyResult?.body,
						},
					);
				} catch {
					/* Document body unavailable */
				}
				return;
			}

			// XHR/Fetch request handling
			const req = pendingRequests.get(params.requestId);
			const res = responseInfo.get(params.requestId);
			pendingRequests.delete(params.requestId);
			responseInfo.delete(params.requestId);
			if (!req || !res) return;

			// Skip responses that are clearly not API data
			const ct = res.contentType.toLowerCase();
			if (
				ct.includes('text/html') ||
				ct.includes('text/css') ||
				ct.includes('image/') ||
				ct.includes('font/')
			)
				return;

			// Skip analytics/tracking
			const skip = [
				'google-analytics',
				'googleadservices',
				'google.com/ccm',
				'sentry.io',
				'forter.com',
				'riskified.com',
				'doubleclick.net',
			];
			if (skip.some((s) => res.url.includes(s))) return;

			try {
				const bodyResult = await this.cdp?.send('Network.getResponseBody', {
					requestId: params.requestId,
				});
				let resBody: unknown = bodyResult?.body;
				if (resBody) {
					try {
						resBody = JSON.parse(resBody as string);
					} catch {
						// keep as string
					}
				}
				this.networkCaptureCallback(req, {
					url: res.url,
					status: res.status,
					headers: res.headers,
					body: resBody,
				});
			} catch {
				/* body unavailable */
			}
		});

		// Clean up on failed requests (prevents memory leak)
		this.cdp.on('Network.loadingFailed', (params: CDPLoadingFailed) => {
			pendingRequests.delete(params.requestId);
			responseInfo.delete(params.requestId);
			documentRequests.delete(params.requestId);
		});

		// WebSocket frame capture — CDP does NOT capture WS frames via requestWillBeSent.
		// These events let us see WebSocket connections and their messages.
		const wsConnections = new Map<string, string>(); // requestId → url

		this.cdp.on('Network.webSocketCreated', (params: CDPWebSocketCreated) => {
			wsConnections.set(params.requestId, params.url);
			if (this.networkCaptureCallback) {
				this.networkCaptureCallback(
					{ method: 'WS', url: params.url, body: null, headers: {} },
					{
						url: params.url,
						status: 101,
						headers: {},
						body: { type: 'websocket-created', wsUrl: params.url },
					},
				);
			}
		});

		this.cdp.on('Network.webSocketFrameReceived', (params: CDPWebSocketFrameReceived) => {
			const url = wsConnections.get(params.requestId) || 'unknown-ws';
			if (!this.networkCaptureCallback) return;
			const payload = params.response?.payloadData || '';
			let body: unknown;
			try {
				body = JSON.parse(payload);
			} catch {
				body = payload.length > 200 ? `[binary/text ${payload.length} bytes]` : payload;
			}
			this.networkCaptureCallback(
				{ method: 'WS-FRAME', url, body: null, headers: {} },
				{
					url,
					status: 0,
					headers: {},
					body: { type: 'websocket-frame', data: body, size: payload.length },
				},
			);
		});

		this.cdp.on('Network.webSocketClosed', (params: CDPWebSocketClosed) => {
			wsConnections.delete(params.requestId);
		});
	}

	/**
	 * Check if browser is running.
	 */
	isActive(): boolean {
		return this.isRunning && this.context !== null;
	}

	// -------------------------------------------------------------------------
	// Private methods
	// -------------------------------------------------------------------------

	private async switchPage(newPage: Page): Promise<void> {
		await this.stopScreencast();

		this.page = newPage;

		if (this.urlChangeCallback) {
			this.urlChangeCallback(newPage.url());
		}

		await this.startScreencast();
	}

	private async startScreencast(): Promise<void> {
		if (!this.page || !this.context) {
			return;
		}

		try {
			this.cdp = await this.context.newCDPSession(this.page);

			// Enable network capture via CDP — catches ALL XHR/Fetch including cross-domain
			await this.cdp.send('Network.enable');
			this.setupNetworkCapture();

			// Reset throttling state
			this.lastFrameSentAt = 0;
			this.pendingFrame = null;

			this.cdp.on(
				'Page.screencastFrame',
				(evt: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
					if (!this.isRunning || !this.frameCallback) {
						return;
					}

					// Always ACK immediately to keep CDP flowing
					void this.cdp?.send('Page.screencastFrameAck', { sessionId: evt.sessionId });

					const bytes = Buffer.from(evt.data, 'base64');
					this.frameId++;

					const frame: FrameData = {
						frameId: this.frameId,
						bytes: new Uint8Array(bytes),
						timestamp: evt.metadata.timestamp ? evt.metadata.timestamp * 1000 : Date.now(),
					};

					// Double-buffer throttling: always keep latest frame, send at interval
					const now = Date.now();
					const elapsed = now - this.lastFrameSentAt;

					if (elapsed >= this.frameIntervalMs) {
						// Enough time passed, send this frame immediately
						this.lastFrameSentAt = now;
						this.pendingFrame = null;
						this.frameCallback(frame);
					} else {
						// Too soon, store as pending (overwrites previous pending)
						const hadPending = this.pendingFrame !== null;
						this.pendingFrame = frame;

						// Schedule send if not already scheduled
						if (!hadPending) {
							const delay = this.frameIntervalMs - elapsed;
							setTimeout(() => {
								if (this.pendingFrame && this.frameCallback && this.isRunning) {
									this.lastFrameSentAt = Date.now();
									this.frameCallback(this.pendingFrame);
									this.pendingFrame = null;
								}
							}, delay);
						}
					}
				},
			);

			// Request frames at max rate from CDP, we throttle on our side
			await this.cdp.send('Page.startScreencast', {
				format: 'jpeg',
				quality: this.config.quality,
				maxWidth: this.config.viewportWidth,
				maxHeight: this.config.viewportHeight,
				everyNthFrame: 1,
			});
		} catch {
			this.handleCrash('Failed to start screencast');
		}
	}

	private async stopScreencast(): Promise<void> {
		if (!this.cdp) return;
		try {
			await this.cdp.send('Page.stopScreencast');
			await this.cdp.detach();
		} catch {
			// Ignore errors during cleanup
		} finally {
			this.cdp = null;
		}
	}

	private handleCrash(reason: string): void {
		if (!this.isRunning) return;

		this.isRunning = false;

		void this.stopScreencast();

		if (this.crashCallback) {
			this.crashCallback(reason);
		}

		this.context = null;
		this.page = null;
	}

	private handleOperationError(operation: string, err: unknown): void {
		const errMsg = err instanceof Error ? err.message : String(err);

		if (
			errMsg.includes('closed') ||
			errMsg.includes('Target page') ||
			errMsg.includes('Target closed')
		) {
			this.handleCrash(`${operation} failed: browser closed`);
			return;
		}

		if (this.errorCallback) {
			this.errorCallback(err instanceof Error ? err : new Error(errMsg));
		}
	}

	private assertPageAvailable(): void {
		if (!this.page) {
			throw new Error('Browser not started');
		}
		if (!this.isRunning) {
			throw new Error('Browser has stopped');
		}
	}
}
