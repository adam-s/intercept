/**
 * Browser WebSocket Handler
 *
 * Adapts the browser lifecycle logic from browser.ts to work with
 * raw Node.js `ws` WebSocket instead of Hono's UpgradeWebSocket.
 *
 * This is the bridge between the raw WebSocket server in index.ts
 * and the fully-implemented RemoteBrowserService + interceptor pipeline.
 *
 * @module browser/handler
 */

import type { WebSocket } from 'ws';
import { digestLargeBody } from '../driver/capture-filter.js';
import {
	BrowserLifecycleManager,
	browserLogger,
	createProfile,
	type FrameData,
	getProfilePath,
	profileExists,
	RemoteBrowserService,
} from '../remote/index.js';
import type { GenericInterceptor } from '../shared/interceptor.js';
import { GenericSessionManager } from '../shared/session-manager.js';
import type { InterceptedRequest, InterceptedResponse } from '../shared/types.js';
import { type DomainPlugin, getDomain } from './domain-loader.js';

// --- Constants ---

const VIEWPORT_WIDTH = 1024;
const VIEWPORT_HEIGHT = 576;

// --- Browser State (module-level singleton — one browser at a time) ---

let activeBrowser: RemoteBrowserService | null = null;
let activeInterceptor: GenericInterceptor | null = null;
let activePlugin: DomainPlugin | undefined;
let browserReady = false;
let currentProfile: string | null = null;
let currentDomain: string | null = null;
let autoRestartAttempts = 0;

// --- Accessors for API proxy layer ---

/** Get the active browser instance (for browserFetch proxy). Returns null if not connected. */
export function getActiveBrowser(): RemoteBrowserService | null {
	return browserReady ? activeBrowser : null;
}

/** Get the currently active domain plugin. */
export function getActivePlugin(): DomainPlugin | undefined {
	return activePlugin;
}

/**
 * Auto-start a headless browser without a WebSocket client.
 *
 * Called at API server startup so domain proxy routes (extractFromPage, browserFetch)
 * work immediately — no manual browser connection via the dashboard required.
 *
 * The browser runs headlessly and shares the same singleton as the WS-connected browser.
 * A subsequent WS connection from the /browser dashboard will reuse it (same profile)
 * or replace it (different profile).
 *
 * Idempotent: safe to call multiple times; no-ops if browser is already ready.
 *
 * @param profile - Optional persistent profile name (uses temp dir if omitted)
 */
export async function autoStartHeadlessBrowser(profile?: string): Promise<void> {
	if (activeBrowser && browserReady) {
		browserLogger.lifecycle('auto_start_skipped', { reason: 'browser already running' });
		return;
	}

	const lifecycleManager = BrowserLifecycleManager.getInstance();
	try {
		await lifecycleManager.acquireLock();
	} catch (lockErr) {
		browserLogger.error(
			'auto_start_lock_timeout',
			lockErr instanceof Error ? lockErr : new Error(String(lockErr)),
			{},
		);
		return;
	}

	try {
		let userDataDir: string | undefined;
		if (profile) {
			if (!profileExists(profile)) createProfile(profile);
			const profilePath = getProfilePath(profile);
			if (profilePath) userDataDir = profilePath;
		}

		// ⚠️  DEFAULT: headless (true). Matches handleBrowserWebSocket behavior (line ~539).
		// Override with BROWSER_HEADLESS=false for one-time manual login through Cloudflare
		// Turnstile via /browser UI (requires display: macOS window or Linux xvfb).
		// Once auth cookies are saved to the browser profile, headless works for all proxy routes.
		const headless = process.env.BROWSER_HEADLESS !== 'false';
		activeBrowser = new RemoteBrowserService({
			fps: 1,
			quality: 30,
			viewportWidth: VIEWPORT_WIDTH,
			viewportHeight: VIEWPORT_HEIGHT,
			headless,
			userDataDir,
		});

		await activeBrowser.start(
			() => {
				// No-op frame callback — no WebSocket client to stream frames to.
				// Frame streaming starts automatically when a WS client connects.
			},
			{
				onError: (err) => browserLogger.error('auto_browser_error', err, {}),
				onCrash: (reason) => {
					browserLogger.error('auto_browser_crash', new Error(reason), {});
					browserReady = false;
					lifecycleManager.unregisterBrowser();
					activeBrowser = null;
					// Auto-restart after crash (max 3 attempts, 5s delay)
					if ((autoRestartAttempts ?? 0) < 3) {
						autoRestartAttempts = (autoRestartAttempts ?? 0) + 1;
						console.log(
							`[browser] Crash detected, auto-restarting (attempt ${autoRestartAttempts}/3)...`,
						);
						setTimeout(() => autoStartHeadlessBrowser(currentProfile ?? 'generic'), 5000);
					} else {
						console.error('[browser] Max auto-restart attempts reached. Manual restart required.');
					}
				},
			},
		);

		// Wire CDP traffic capture so /browser/traffic works on auto-started browser
		activeBrowser.onNetworkCapture((req, res) => {
			addTrafficEntry(
				{
					url: req.url,
					method: req.method,
					headers: req.headers,
					body: req.body,
					timestamp: Date.now(),
				},
				{
					url: res.url,
					status: res.status,
					headers: res.headers,
					body: res.body,
					timestamp: Date.now(),
				},
			);
		});

		browserReady = true;
		autoRestartAttempts = 0; // Reset on successful start
		currentProfile = profile ?? null;
		lifecycleManager.registerBrowser(activeBrowser);
		browserLogger.lifecycle('auto_started', { profile: profile ?? 'headless-temp' });
		console.log('[browser] Auto-started headless browser — proxy routes + traffic capture ready');
	} catch (err) {
		browserLogger.error(
			'auto_start_failed',
			err instanceof Error ? err : new Error(String(err)),
			{},
		);
		activeBrowser = null;
	} finally {
		lifecycleManager.releaseLock();
	}
}

// --- Traffic Capture Buffer ---

interface TrafficEntry {
	id: number;
	timestamp: number;
	method: string;
	url: string;
	requestHeaders: Record<string, string>;
	requestBody: unknown;
	status: number;
	responseHeaders: Record<string, string>;
	responseBody: unknown;
	durationMs: number;
}

const MAX_TRAFFIC_ENTRIES = 200;
const MAX_BODY_SIZE = 50_000;

let trafficBuffer: TrafficEntry[] = [];
let trafficIdCounter = 0;

function addTrafficEntry(req: InterceptedRequest, res: InterceptedResponse): void {
	let responseBody = res.body;
	try {
		const bodyStr = JSON.stringify(responseBody);
		if (bodyStr.length > MAX_BODY_SIZE) {
			// Keeps the embedded-data regions rather than only the first two
			// thousand characters. A head-slice drops exactly what a document is
			// captured for: hydration payloads and semantic markup sit deep in a
			// page, so a large server-rendered site reported no embedded data while
			// the data sat in the part that was discarded.
			responseBody = digestLargeBody(bodyStr);
		}
	} catch {
		/* not serializable */
	}

	trafficBuffer.push({
		id: ++trafficIdCounter,
		timestamp: req.timestamp,
		method: req.method,
		url: req.url,
		requestHeaders: req.headers,
		requestBody: req.body,
		status: res.status,
		responseHeaders: res.headers,
		responseBody,
		durationMs: res.timestamp - req.timestamp,
	});

	if (trafficBuffer.length > MAX_TRAFFIC_ENTRIES) {
		trafficBuffer.shift();
	}
}

// --- Traffic Buffer Accessors (used by REST endpoints in index.ts) ---

export function getTrafficEntries(sinceId?: number): {
	entries: TrafficEntry[];
	total: number;
	oldestId: number;
	newestId: number;
} {
	let entries = trafficBuffer;
	if (sinceId !== undefined && !Number.isNaN(sinceId)) {
		entries = entries.filter((e) => e.id > sinceId);
	}
	return {
		entries,
		total: trafficBuffer.length,
		oldestId: trafficBuffer[0]?.id ?? 0,
		newestId: trafficBuffer[trafficBuffer.length - 1]?.id ?? 0,
	};
}

export function getTrafficSummary(): {
	totalEntries: number;
	uniqueEndpoints: number;
	endpoints: Array<{ pattern: string; count: number; methods: string[]; statuses: number[] }>;
} {
	const urlPatterns = new Map<
		string,
		{ count: number; methods: Set<string>; statuses: Set<number> }
	>();
	for (const entry of trafficBuffer) {
		const pattern = entry.url
			.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/{id}')
			.replace(/\/\d+\//g, '/{id}/')
			.replace(/\?.*$/, '');
		const existing = urlPatterns.get(pattern) || {
			count: 0,
			methods: new Set(),
			statuses: new Set(),
		};
		existing.count++;
		existing.methods.add(entry.method);
		existing.statuses.add(entry.status);
		urlPatterns.set(pattern, existing);
	}

	const endpoints = Array.from(urlPatterns.entries()).map(([pattern, data]) => ({
		pattern,
		count: data.count,
		methods: Array.from(data.methods),
		statuses: Array.from(data.statuses),
	}));

	return {
		totalEntries: trafficBuffer.length,
		uniqueEndpoints: endpoints.length,
		endpoints: endpoints.sort((a, b) => b.count - a.count),
	};
}

export function clearTrafficBuffer(): number {
	const count = trafficBuffer.length;
	trafficBuffer = [];
	return count;
}

export function getBrowserHealth(): {
	status: string;
	browser: { active: boolean; ready: boolean; profile: string | null; domain: string | null };
	lifecycle: unknown;
	metrics: unknown;
	timestamp: string;
} {
	const lifecycleManager = BrowserLifecycleManager.getInstance();
	return {
		status: 'ok',
		browser: {
			active: activeBrowser !== null,
			ready: browserReady,
			profile: currentProfile,
			domain: currentDomain,
		},
		lifecycle: lifecycleManager.getStatus(),
		metrics: browserLogger.getMetrics(),
		timestamp: new Date().toISOString(),
	};
}

// --- Safe send helpers ---

function wsSend(ws: WebSocket, data: string | Buffer | Uint8Array): void {
	try {
		ws.send(data);
	} catch {
		// Client may have disconnected
	}
}

function wsSendJson(ws: WebSocket, obj: unknown): void {
	wsSend(ws, JSON.stringify(obj));
}

// --- WebSocket Message Dispatch ---

/**
 * Handle a parsed WebSocket message by dispatching to the active browser.
 * Shared between the fresh-browser and reuse-browser code paths.
 */
async function handleWsMessage(message: Record<string, unknown>, ws: WebSocket): Promise<void> {
	if (!activeBrowser || !browserReady) return;

	switch (message.type) {
		case 'navigate':
			if (message.url) await activeBrowser.navigate(message.url as string);
			break;
		case 'mousemove':
			if (typeof message.x === 'number' && typeof message.y === 'number')
				await activeBrowser.mouseMove(message.x, message.y);
			break;
		case 'click':
			if (typeof message.x === 'number' && typeof message.y === 'number')
				await activeBrowser.click(
					message.x,
					message.y,
					(message.button as 'left' | 'right' | 'middle') || 'left',
				);
			break;
		case 'mousedown':
			if (typeof message.x === 'number' && typeof message.y === 'number')
				await activeBrowser.mouseDown(
					message.x,
					message.y,
					(message.button as 'left' | 'right' | 'middle') || 'left',
				);
			break;
		case 'mouseup':
			if (typeof message.x === 'number' && typeof message.y === 'number')
				await activeBrowser.mouseUp(
					message.x,
					message.y,
					(message.button as 'left' | 'right' | 'middle') || 'left',
				);
			break;
		case 'dblclick':
			if (typeof message.x === 'number' && typeof message.y === 'number')
				await activeBrowser.doubleClick(message.x, message.y);
			break;
		case 'type':
			if (message.text) await activeBrowser.type(message.text as string);
			break;
		case 'key':
			if (message.key) await activeBrowser.pressKey(message.key as string);
			break;
		case 'scroll':
			if (typeof message.x === 'number' && typeof message.y === 'number')
				await activeBrowser.scroll(
					message.x,
					message.y,
					(message.deltaX as number) || 0,
					(message.deltaY as number) || 0,
				);
			break;
		case 'paste':
			if (message.text) await activeBrowser.paste(message.text as string);
			break;
		case 'copy': {
			const text = await activeBrowser.copy();
			wsSendJson(ws, { type: 'clipboard', text });
			break;
		}
		case 'back':
			await activeBrowser.goBack();
			break;
		case 'forward':
			await activeBrowser.goForward();
			break;
		case 'reload':
			await activeBrowser.reload();
			break;
		case 'setFps':
			if (typeof message.fps === 'number') {
				activeBrowser.setFps(message.fps);
				wsSendJson(ws, { type: 'fpsChanged', fps: activeBrowser.getFps() });
			}
			break;
		case 'getFps':
			wsSendJson(ws, { type: 'currentFps', fps: activeBrowser.getFps() });
			break;
		case 'warmup': {
			const sites = typeof message.sites === 'number' ? message.sites : 3;
			const delay = typeof message.delay === 'number' ? message.delay : 2000;
			wsSendJson(ws, { type: 'warmup_started', sites });
			await activeBrowser.warmup(sites, delay);
			wsSendJson(ws, { type: 'warmup_complete' });
			break;
		}
	}
}

/**
 * Wire the standard WS message handler to parse JSON and dispatch.
 */
function wireWsMessageHandler(ws: WebSocket): void {
	ws.on('message', async (data: Buffer) => {
		try {
			const str = data.toString();
			const message = JSON.parse(str) as Record<string, unknown>;
			if (message.type !== 'mousemove') {
				console.log(
					'[BrowserWS] msg:',
					message.type,
					'activeBrowser:',
					!!activeBrowser,
					'ready:',
					browserReady,
				);
			}
			await handleWsMessage(message, ws);
		} catch (err) {
			console.error('[BrowserWS] message handler error:', err instanceof Error ? err.message : err);
		}
	});
}

// --- WebSocket Handler ---

/**
 * Handle a browser streaming WebSocket connection.
 *
 * This is called from index.ts when a WebSocket connects to /browser/stream.
 * It manages the full browser lifecycle: launch, stream frames, handle input,
 * capture traffic, and clean up on disconnect.
 */
export async function handleBrowserWebSocket(ws: WebSocket, requestUrl: URL): Promise<void> {
	const profile = requestUrl.searchParams.get('profile') || undefined;
	const url = requestUrl.searchParams.get('url') || undefined;
	const _captureDomainsParam = requestUrl.searchParams.get('capture') || undefined;
	// Per-connection headless override: ?headless=false launches a visible window.
	// Used by observation harnesses (domains/build-nvidia/scripts/observe-human.ts)
	// where a human drives input. Falls back to the BROWSER_HEADLESS env default.
	const headlessParam = requestUrl.searchParams.get('headless');
	const headlessOverride =
		headlessParam === 'false' ? false : headlessParam === 'true' ? true : null;

	// Wire message handler FIRST — before any async work.
	// Messages from the frontend can arrive immediately after WS upgrade.
	// If we wire after async browser startup, early messages are silently dropped.
	wireWsMessageHandler(ws);

	browserLogger.connection('open', {
		profile: profile || 'temp',
		url: url || undefined,
	});

	// --- onOpen logic (adapted from browser.ts lines 195-561) ---

	const lifecycleManager = BrowserLifecycleManager.getInstance();
	try {
		await lifecycleManager.acquireLock();
	} catch (lockErr) {
		browserLogger.error(
			'lock_timeout',
			lockErr instanceof Error ? lockErr : new Error(String(lockErr)),
			{ profile },
		);
		wsSendJson(ws, { type: 'error', message: 'Browser lock timed out — try reconnecting' });
		ws.close(1011, 'Lock timeout');
		return;
	}

	try {
		// Reuse existing browser if same profile is already running
		const reusingBrowser = activeBrowser && browserReady && currentProfile === (profile || null);

		if (activeBrowser && !reusingBrowser) {
			// Different profile — destroy existing browser
			browserLogger.lifecycle('cleanup_existing', { profile: currentProfile || 'unknown' });
			try {
				if (activeInterceptor) {
					await activeInterceptor.detach();
					activeInterceptor = null;
				}
				await activeBrowser.stop();
				browserLogger.lifecycle('cleanup_success', { profile: currentProfile || 'unknown' });
			} catch (cleanupErr) {
				browserLogger.error(
					'cleanup_failed',
					cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr)),
					{ profile: currentProfile },
				);
			}
			activeBrowser = null;
			lifecycleManager.unregisterBrowser();
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		if (reusingBrowser) {
			// Same profile already running — reuse browser, just wire new frame callback + navigate
			browserLogger.lifecycle('reusing_browser', { profile: currentProfile || 'unknown' });

			// Update frame callback so this new WS client actually receives frames.
			activeBrowser?.setFrameCallback((frame: FrameData) => {
				wsSend(ws, frame.bytes as Uint8Array<ArrayBuffer>);
			});

			// Boost FPS and quality for interactive viewing (auto-start runs at 1fps/q30)
			activeBrowser?.setFps(4);
			activeBrowser?.setQuality(60);

			wsSendJson(ws, {
				type: 'ready',
				viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
				profile: profile || null,
				reused: true,
			});

			// Force an immediate screenshot so client sees something right away.
			// CDP screencast is event-driven — no visual change = no frame.
			await activeBrowser?.captureAndSendFrame();

			if (url) {
				browserLogger.debug(`Navigating existing browser to: ${url}`);
				await activeBrowser?.navigate(url);
			}

			lifecycleManager.releaseLock();

			ws.on('close', () => {
				browserLogger.connection('close', { profile: currentProfile || 'unknown', reused: true });
				// Reset to low FPS for background proxy operation
				if (activeBrowser) {
					activeBrowser.setFps(1);
					activeBrowser.setQuality(30);
				}
			});

			return; // Skip the rest of the setup
		}

		browserReady = false;
		currentProfile = profile || null;
		currentDomain = null;

		// Handle persistent profile
		let userDataDir: string | undefined;
		if (profile) {
			if (!profileExists(profile)) {
				browserLogger.profile('create', profile);
				createProfile(profile);
			}
			const profilePath = getProfilePath(profile);
			if (profilePath) {
				userDataDir = profilePath;
				browserLogger.profile('load', profile, { path: userDataDir });
			}
		}

		activeBrowser = new RemoteBrowserService({
			fps: 4, // Interactive viewing — WS client is connected
			quality: 60, // Better image quality for human viewing
			viewportWidth: VIEWPORT_WIDTH,
			viewportHeight: VIEWPORT_HEIGHT,
			headless: headlessOverride ?? process.env.BROWSER_HEADLESS !== 'false',
			userDataDir,
		});

		// Headed override gets logged so we can see in /tmp/api-server.log that the
		// observation harness actually got a visible window.
		if (headlessOverride === false) {
			browserLogger.lifecycle('headed_override', { profile: profile || 'temp' });
		}

		try {
			browserLogger.lifecycle('starting', { profile: profile || 'temp', userDataDir });

			await activeBrowser.start(
				(frame: FrameData) => {
					// Send binary JPEG frames — ws handles Buffer/Uint8Array natively
					wsSend(ws, frame.bytes as Uint8Array<ArrayBuffer>);
				},
				{
					onError: (error) => {
						browserLogger.error('browser_error', error, { profile });
						wsSendJson(ws, { type: 'error', message: error.message });
					},
					onCrash: (reason) => {
						browserLogger.error('browser_crash', new Error(reason), { profile });
						browserReady = false;
						lifecycleManager.unregisterBrowser();
						wsSendJson(ws, { type: 'crash', reason });
						ws.close(1011, 'Browser crashed');
						activeBrowser = null;
						activeInterceptor = null;
					},
				},
			);

			browserLogger.lifecycle('started', { profile: profile || 'temp' });
			browserReady = true;
			lifecycleManager.registerBrowser(activeBrowser);

			// Attach domain-specific interceptor if config exists
			if (profile) {
				const config = getDomain(profile);
				if (config) {
					currentDomain = config.domainName;
					activePlugin = config;
					browserLogger.debug(`Attaching interceptor for domain: ${config.domainName}`);

					const page = activeBrowser.getPage();
					if (page) {
						activeInterceptor = config.createInterceptor();

						activeInterceptor.onHeadersCaptured = async (headers) => {
							browserLogger.debug(`Headers captured for domain: ${config.domainName}`);
							const manager = GenericSessionManager.getInstance(config.domainName);
							manager.setHeaders(profile, headers);

							if (config.verifyCredentials) {
								browserLogger.debug(`Verifying credentials for domain: ${config.domainName}`);
								const result = await config.verifyCredentials(headers);

								if (result.valid) {
									manager.markVerified(profile, {
										accountNumber: result.accountNumber || '',
										firstName: (result as Record<string, unknown>).firstName as string | undefined,
										lastName: (result as Record<string, unknown>).lastName as string | undefined,
										buyingPower: (result as Record<string, unknown>).buyingPower as
											| string
											| undefined,
									});
									browserLogger.debug(`${config.domainName} VERIFIED: ${JSON.stringify(result)}`);
									const message = config.onVerified
										? config.onVerified(result)
										: { type: `${config.domainName}_verified`, ...result };
									wsSendJson(ws, message);
								} else {
									manager.markVerificationFailed(profile, result.error || 'Unknown error');
									browserLogger.warn(`${config.domainName}_verification_failed`, {
										error: result.error,
									});
									const message = config.onVerificationFailed
										? config.onVerificationFailed(result.error || 'Unknown error')
										: { type: `${config.domainName}_verification_failed`, error: result.error };
									wsSendJson(ws, message);
								}
							}
						};

						// Wire traffic capture
						activeInterceptor.onIntercept((req, res) => {
							addTrafficEntry(req, res);
						});

						await activeInterceptor.attach(page);
						browserLogger.debug(
							`${config.domainName} interceptor attached + traffic capture enabled`,
						);
					}
				}
			}

			// CDP-based traffic capture — catches ALL XHR/Fetch requests across all domains.
			// Network.enable is set up inside RemoteBrowserService.startScreencast().
			// We just register the callback to route captured traffic into our buffer.
			if (activeBrowser) {
				activeBrowser.onNetworkCapture((req, res) => {
					addTrafficEntry(
						{
							url: req.url,
							method: req.method,
							headers: req.headers,
							body: req.body,
							timestamp: Date.now(),
						},
						{
							url: res.url,
							status: res.status,
							headers: res.headers,
							body: res.body,
							timestamp: Date.now(),
						},
					);
				});
				browserLogger.debug('CDP traffic capture enabled (all domains, JSON only)');
			}

			// URL change tracking + login detection
			let lastUrl: string | null = null;
			let headersCapturedInThisSession = false;

			if (activeInterceptor) {
				const originalCallback = activeInterceptor.onHeadersCaptured;
				activeInterceptor.onHeadersCaptured = async (headers) => {
					headersCapturedInThisSession = true;
					if (originalCallback) await originalCallback(headers);
				};
			}

			activeBrowser.onUrlChange((changedUrl) => {
				wsSendJson(ws, { type: 'url', url: changedUrl });

				if (activePlugin?.detectLoginPage) {
					const isLoginPage = activePlugin.detectLoginPage(changedUrl);
					const wasOnAuthenticatedPage = lastUrl && !activePlugin.detectLoginPage(lastUrl);

					if (isLoginPage && wasOnAuthenticatedPage && headersCapturedInThisSession) {
						const message = activePlugin.onLoginDetected
							? activePlugin.onLoginDetected()
							: { type: `${activePlugin.domainName}_login_page_detected` };
						wsSendJson(ws, message);
					}
				}

				lastUrl = changedUrl;
			});

			wsSendJson(ws, {
				type: 'ready',
				viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
				profile: profile || null,
			});

			// Force an immediate screenshot so client sees something right away.
			// CDP screencast is event-driven on visual changes — blank page = no frame.
			await activeBrowser.captureAndSendFrame();

			// Auto-navigate if URL was provided
			if (url) {
				browserLogger.debug(`Auto-navigating to: ${url}`);
				await activeBrowser.navigate(url);
			}

			browserLogger.connection('ready', { profile: profile || 'temp' });
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			browserLogger.error('start_failed', err instanceof Error ? err : new Error(errorMessage), {
				profile,
			});
			wsSendJson(ws, { type: 'error', message: `Failed to start browser: ${errorMessage}` });
		}
	} finally {
		lifecycleManager.releaseLock();
	}

	// --- onClose handler ---
	// Browser stays alive when WebSocket disconnects — proxy continues to work.
	// Browser is only stopped when a different profile connects or server shuts down.

	ws.on('close', () => {
		browserLogger.connection('close', {
			profile: currentProfile || 'unknown',
			browserKeptAlive: true,
		});
		// DO NOT stop the browser — it stays alive for proxy API calls.
		// Reset to low FPS/quality for background proxy operation.
		if (activeBrowser) {
			activeBrowser.setFps(1);
			activeBrowser.setQuality(30);
		}
	});
}
