/**
 * ChatGPT Domain Routes
 *
 * Exposes ChatGPT's internal API through a privacy-first proxy.
 * All routes are mounted at /api/chatgpt/<path> by the domain framework.
 *
 * ─── Chat (primary) ────────────────────────────────────────────────────
 *
 *   POST /chat
 *     Proxy chatgpt.com/backend-api/conversation via browserFetch.
 *     Streams the SSE response through as text/event-stream.
 *     Requires a harvested Bearer token — call POST /session/harvest first.
 *
 *   GET /models
 *     List available models from backend-api/models.
 *
 * ─── Session management ────────────────────────────────────────────────
 *
 *   GET  /session         — Status of harvested token (connected/age/email)
 *   POST /session/harvest — Harvest Bearer token from active browser page
 *
 * ─── Fingerprint privacy layer ─────────────────────────────────────────
 *
 *   GET  /fingerprint/profile  — Active FingerprintProfile (null = passthrough)
 *   PUT  /fingerprint/profile  — Set persona profile (loaded from JSON or inline)
 *   POST /fingerprint/attach   — Attach ChatGPTScriptInterceptor to browser page
 *                                Body: { mode: 'log' | 'control' }
 *                                'control' mode = privacy mode (persona replaces real data)
 *   GET  /fingerprint/log      — SSE stream of FingerprintLogEntry events
 *                                Shows what Turnstile/Sentinel is collecting
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import type { InitScriptHandle, RemoteBrowserService } from '@interceptor/browser/remote';
import { DEEP_LOGGER_SCRIPT } from './experiments/deep-logger';
import { ChatGPTScriptInterceptor } from './fingerprint';
import { openaiAdapterRoutes } from './openai-adapter';
import { ChatGPTSessionManager } from './session';
import type { ChatGPTInterceptorMode, FingerprintProfile } from './types';

const CHATGPT_BASE = 'https://chatgpt.com';
const CHROME_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * Hybrid Priority-1 conversation submitter.
 *
 * Mints fresh per-message Sentinel tokens via the page's
 * `window.SentinelSDK.token(flow)` (loaded on first call), harvests cookies
 * + device id from the live browser session, and POSTs
 * `/backend-anon/f/conversation` directly via Bun fetch.
 *
 * Why this works where pure-Bun didn't:
 *   - The SDK runs the per-message proof-of-work + turnstile inside the
 *     real browser, so the values are valid for the active device session.
 *   - The actual conversation POST goes from Bun (BoringSSL TLS) which
 *     Cloudflare accepts, and OpenAI's edge accepts because the browser
 *     also has the same `oai-did` + cookies (so the server-side device
 *     bind is consistent — there's only one client, not two with
 *     different fingerprints racing).
 *
 * Returns the raw SSE body. Caller decides whether to forward it as-is
 * or re-encode (e.g., to OpenAI's chunk format).
 */
export async function sentinelGatedConversation(
	browser: RemoteBrowserService,
	message: string,
	opts: {
		model?: string;
		parentMessageId?: string;
		flow?: string;
		messageId?: string;
	} = {},
): Promise<{ status: number; contentType: string | null; body: string }> {
	const page = browser.getPage();
	if (!page) throw new Error('Browser not connected');
	if (!page.url().startsWith('https://chatgpt.com/')) {
		throw new Error(`Browser not on chatgpt.com (currently: ${page.url()})`);
	}

	// 1. Mint tokens. SDK loads on first call; subsequent calls reuse the
	//    in-page module. Tokens come back as JSON {p, t, c, id, flow}.
	const tokenJson = await page.evaluate(`(async () => {
		if (!window.SentinelSDK) {
			const r = await fetch('/sentinel/20260423af3c/sdk.js');
			const text = await r.text();
			(0, eval)(text);
		}
		if (!window.SentinelSDK || !window.SentinelSDK.token) {
			throw new Error('SentinelSDK not available after load');
		}
		return await window.SentinelSDK.token(${JSON.stringify(opts.flow ?? 'next')});
	})()`);

	let tokens: { p?: string; t?: string; c?: string; id?: string; flow?: string };
	if (typeof tokenJson === 'string') {
		try {
			tokens = JSON.parse(tokenJson);
		} catch {
			throw new Error(`SentinelSDK.token returned non-JSON: ${tokenJson.slice(0, 200)}`);
		}
	} else if (typeof tokenJson === 'object' && tokenJson !== null) {
		tokens = tokenJson as typeof tokens;
	} else {
		throw new Error(`SentinelSDK.token returned unexpected: ${typeof tokenJson}`);
	}
	if (!tokens.p || !tokens.t || !tokens.c) {
		throw new Error(`SentinelSDK.token missing fields: ${JSON.stringify(Object.keys(tokens))}`);
	}

	// 2. Harvest cookies + device id.
	const cookies = (await page.evaluate(() => document.cookie)) as string;
	const did = (cookies.match(/oai-did=([a-f0-9-]+)/) ?? [])[1] ?? tokens.id ?? '';

	// 3. Build conversation body.
	const messageId = opts.messageId ?? crypto.randomUUID();
	const turnTraceId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	const reqBody = {
		action: 'next',
		messages: [
			{
				id: messageId,
				author: { role: 'user' },
				create_time: Date.now() / 1000,
				content: { content_type: 'text', parts: [message] },
				metadata: {
					selected_github_repos: [],
					selected_all_github_repos: false,
					serialization_metadata: { custom_symbol_offsets: [] },
				},
			},
		],
		parent_message_id: opts.parentMessageId ?? 'client-created-root',
		model: opts.model ?? 'auto',
		client_prepare_state: 'sent',
		timezone_offset_min: 240,
		timezone: 'America/New_York',
		conversation_mode: { kind: 'primary_assistant' },
		enable_message_followups: true,
		system_hints: [],
		supports_buffering: true,
		supported_encodings: ['v1'],
		client_contextual_info: {
			is_dark_mode: false,
			time_since_loaded: 5000,
			page_height: 576,
			page_width: 1024,
			pixel_ratio: 1,
			screen_height: 576,
			screen_width: 1024,
			app_name: 'chatgpt.com',
		},
		no_auth_ad_preferences: {
			personalization_enabled: true,
			history_enabled: true,
			bazaar_consent_set: false,
		},
		paragen_cot_summary_display_override: 'allow',
		force_parallel_switch: 'auto',
	};

	// 4. Bun fetch with the freshly-minted tokens. We send the same TLS+HTTP/2
	//    fingerprint Bun's BoringSSL produces — Cloudflare passes, and the
	//    server-side device-bind is consistent because we're using the live
	//    browser's own cookies.
	const r = await fetch(`${CHATGPT_BASE}/backend-anon/f/conversation`, {
		method: 'POST',
		headers: {
			'user-agent': CHROME_UA,
			cookie: cookies,
			'content-type': 'application/json',
			accept: 'text/event-stream',
			origin: 'https://chatgpt.com',
			referer: 'https://chatgpt.com/',
			'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
			'sec-ch-ua-mobile': '?0',
			'sec-ch-ua-platform': '"macOS"',
			'sec-fetch-mode': 'cors',
			'sec-fetch-dest': 'empty',
			'sec-fetch-site': 'same-origin',
			'oai-language': 'en-US',
			'oai-device-id': did,
			'oai-client-version': 'prod-e72ce87e983a564c22178e7872785a3f094cfdff',
			'oai-client-build-number': '6311184',
			'oai-session-id': sessionId,
			'x-openai-target-path': '/backend-api/f/conversation',
			'x-openai-target-route': '/backend-api/f/conversation',
			'oai-echo-logs': '0,42000',
			'oai-telemetry': '[1,null]',
			'x-oai-turn-trace-id': turnTraceId,
			'openai-sentinel-chat-requirements-token': tokens.c,
			'openai-sentinel-proof-token': tokens.p,
			'openai-sentinel-turnstile-token': tokens.t,
		},
		body: JSON.stringify(reqBody),
	});

	const body = await r.text();
	return { status: r.status, contentType: r.headers.get('content-type'), body };
}

// Shared interceptor instance (one per server process)
let scriptInterceptor: ChatGPTScriptInterceptor | null = null;
let activeProfile: FingerprintProfile | undefined;

function getOrCreateInterceptor(
	mode: ChatGPTInterceptorMode,
	profile?: FingerprintProfile,
): ChatGPTScriptInterceptor {
	if (!scriptInterceptor) {
		scriptInterceptor = new ChatGPTScriptInterceptor(mode, profile);
	} else {
		scriptInterceptor.setMode(mode);
		scriptInterceptor.setProfile(profile);
	}
	return scriptInterceptor;
}

export const routes: DomainRoute[] = [
	// ─── Chat ─────────────────────────────────────────────────────────

	{
		method: 'POST',
		path: '/chat',
		description:
			'Anonymous-flow proxy for chatgpt.com. Mints fresh per-message ' +
			"Sentinel proof+turnstile tokens via the page's SentinelSDK, then " +
			'POSTs /backend-anon/f/conversation directly via Bun fetch. The ' +
			'browser must be running and on chatgpt.com so the SDK has device ' +
			'state to draw on, but no UI driving — multiple concurrent /chat ' +
			'calls work because each gets its own SDK token() call.',
		handler: async (c, browser) => {
			let body: { message?: string; model?: string; parentMessageId?: string };
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: 'Request body must be JSON' }, 400);
			}
			if (!body.message) {
				return c.json({ error: 'message is required' }, 400);
			}

			const page = browser.getPage();
			if (!page) return c.json({ error: 'Browser not connected.' }, 503);
			if (!page.url().startsWith('https://chatgpt.com/')) {
				return c.json(
					{
						error: 'Browser is not on chatgpt.com.',
						currentUrl: page.url(),
					},
					412,
				);
			}

			let result: { status: number; contentType: string | null; body: string };
			try {
				result = await sentinelGatedConversation(browser, body.message, {
					model: body.model,
					parentMessageId: body.parentMessageId,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ error: 'sentinel-gated submit failed', detail: msg }, 502);
			}

			return new Response(result.body, {
				status: result.status,
				headers: {
					'Content-Type': result.contentType ?? 'text/event-stream',
					'Cache-Control': 'no-cache',
					'X-Accel-Buffering': 'no',
				},
			});
		},
	},

	// ─── Models ───────────────────────────────────────────────────────

	{
		method: 'GET',
		path: '/models',
		description: 'List available ChatGPT models.',
		handler: async (c, browser) => {
			const session = ChatGPTSessionManager.getInstance();
			if (!session.getAccessToken()) {
				return c.json(
					{ error: 'No access token. Call POST /api/chatgpt/session/harvest first.' },
					401,
				);
			}

			const result = await browser.browserFetch<Record<string, unknown>>(
				`${CHATGPT_BASE}/backend-api/models`,
				{
					headers: {
						Authorization: `Bearer ${session.getAccessToken()}`,
						Accept: 'application/json',
					},
				},
			);

			return c.json(result.data ?? { error: 'No data' }, result.status as 200);
		},
	},

	// ─── Session ──────────────────────────────────────────────────────

	{
		method: 'GET',
		path: '/session',
		description: 'Get ChatGPT session status.',
		browserRequired: false,
		handler: async (c) => {
			const status = ChatGPTSessionManager.getInstance().getStatus();
			return c.json(status);
		},
	},

	{
		method: 'POST',
		path: '/session/harvest',
		description: 'Harvest Bearer token from the active browser page (must be on chatgpt.com).',
		handler: async (c, browser) => {
			const page = browser.getPage();
			if (!page) {
				return c.json({ error: 'Browser not connected or no active page.' }, 503);
			}

			const result = await ChatGPTSessionManager.getInstance().harvestSession(page);
			return c.json(result, result.ok ? 200 : 500);
		},
	},

	// ─── Fingerprint privacy layer ────────────────────────────────────

	{
		method: 'GET',
		path: '/fingerprint/profile',
		description: 'Get the active fingerprint persona profile.',
		browserRequired: false,
		handler: async (c) => {
			return c.json(activeProfile ?? null);
		},
	},

	{
		method: 'PUT',
		path: '/fingerprint/profile',
		description: 'Set the active fingerprint persona profile.',
		browserRequired: false,
		handler: async (c) => {
			let profile: FingerprintProfile;
			try {
				profile = await c.req.json();
			} catch {
				return c.json({ error: 'Request body must be JSON matching FingerprintProfile' }, 400);
			}
			activeProfile = profile;
			if (scriptInterceptor) {
				scriptInterceptor.setProfile(profile);
			}
			return c.json({ ok: true, profile });
		},
	},

	{
		method: 'POST',
		path: '/fingerprint/attach',
		description:
			'Attach ChatGPTScriptInterceptor to the active browser page. ' +
			'mode=control enables privacy mode (persona replaces real fingerprint data).',
		handler: async (c, browser) => {
			const page = browser.getPage();
			const control = browser.getScriptControl();
			if (!page || !control) {
				return c.json({ error: 'Browser not connected or no active page.' }, 503);
			}

			let mode: ChatGPTInterceptorMode = 'control';
			try {
				const body = (await c.req.json()) as { mode?: ChatGPTInterceptorMode };
				if (body.mode === 'log' || body.mode === 'control') mode = body.mode;
			} catch {
				// default to 'control'
			}

			const interceptor = getOrCreateInterceptor(mode, activeProfile);
			await interceptor.attach(control);
			await interceptor.bindLogChannel(page);

			return c.json({
				ok: true,
				mode,
				hasProfile: !!activeProfile,
				message:
					mode === 'control'
						? 'Privacy mode active — Turnstile will see persona data, not your real device.'
						: 'Log mode active — observing what Turnstile collects.',
			});
		},
	},

	{
		method: 'GET',
		path: '/fingerprint/log',
		description: 'SSE stream of FingerprintLogEntry events — shows what Turnstile is collecting.',
		handler: async (c, _browser) => {
			const interceptor = scriptInterceptor;

			if (!interceptor) {
				return c.json(
					{ error: 'Interceptor not attached. Call POST /api/chatgpt/fingerprint/attach first.' },
					409,
				);
			}

			// SSE stream
			const stream = new ReadableStream({
				start(controller) {
					const enc = new TextEncoder();

					const onEntry = (entry: unknown) => {
						try {
							controller.enqueue(enc.encode(`data: ${JSON.stringify(entry)}\n\n`));
						} catch {
							// Client disconnected
						}
					};

					interceptor.on('entry', onEntry);

					// Cleanup when client disconnects
					c.req.raw.signal.addEventListener('abort', () => {
						interceptor.off('entry', onEntry);
						controller.close();
					});
				},
			});

			return new Response(stream, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					'X-Accel-Buffering': 'no',
				},
			});
		},
	},

	// ─── Experimental — pre-evaluation deep logger ────────────────────
	// EXPERIMENTAL: not for production. Used to reverse-engineer the
	// Sentinel handshake by hooking every transport before any page
	// script runs. See domains/chatgpt/src/experiments/deep-logger.ts.
	...experimentRoutes(),

	// ─── OpenAI-compatible adapter (for AnythingLLM + OpenAI SDK clients) ──
	...openaiAdapterRoutes,
];

// State for the deep-logger lifecycle.
let deepLoggerHandle: InitScriptHandle | null = null;
// Node-side accumulator for entries emitted via the page binding
// `window.__deep_emit(json)`. The binding is installed once per page on
// first /experiments/install-deep-logger call. The accumulator is read +
// cleared by /experiments/drain-logs.
const deepLoggerEntries: unknown[] = [];
const deepLoggerBoundPages = new WeakSet<object>();

function experimentRoutes(): DomainRoute[] {
	return [
		{
			method: 'POST',
			path: '/experiments/install-deep-logger',
			description:
				'EXPERIMENTAL: install the pre-evaluation deep logger via CdpScriptControl. ' +
				'Runs in main world before any in-page or iframe script. Also installs a ' +
				'`window.__deep_emit` page binding so log entries reach Node directly ' +
				"(bypassing Patchright's isolated-world evaluator). " +
				'Re-installation is idempotent (same handle returned).',
			handler: async (c, browser) => {
				const control = browser.getScriptControl();
				const page = browser.getPage();
				if (!control || !page) {
					return c.json({ error: 'Browser not running.' }, 503);
				}

				// Install the page binding the logger calls. Survives navigations.
				if (!deepLoggerBoundPages.has(page)) {
					deepLoggerBoundPages.add(page);
					await page
						.exposeFunction('__deep_emit', (json: string) => {
							try {
								deepLoggerEntries.push(JSON.parse(json));
							} catch {
								/* ignore malformed entry */
							}
						})
						.catch(() => {
							/* binding may already exist on persistent contexts */
						});
				}

				if (deepLoggerHandle) {
					return c.json({ ok: true, handleId: deepLoggerHandle.id, alreadyInstalled: true });
				}
				deepLoggerHandle = await control.registerInitScript(DEEP_LOGGER_SCRIPT);
				return c.json({ ok: true, handleId: deepLoggerHandle.id, alreadyInstalled: false });
			},
		},

		{
			method: 'POST',
			path: '/experiments/uninstall-deep-logger',
			description: 'EXPERIMENTAL: remove the deep logger init script.',
			handler: async (c, browser) => {
				const control = browser.getScriptControl();
				if (!control || !deepLoggerHandle) {
					return c.json({ ok: false, reason: 'not installed' });
				}
				await control.unregisterInitScript(deepLoggerHandle);
				deepLoggerHandle = null;
				return c.json({ ok: true });
			},
		},

		{
			method: 'GET',
			path: '/experiments/drain-logs',
			description:
				'EXPERIMENTAL: read top.__deep_log via CDP Runtime.evaluate in MAIN world ' +
				"(Patchright's page.evaluate uses an isolated world that cannot see the " +
				"logger's buffer). Each call advances top.__deep_log_offset.",
			handler: async (c, browser) => {
				const control = browser.getScriptControl();
				if (!control) return c.json({ error: 'Browser not running.' }, 503);
				const result = await control.evaluateInMainWorld<{
					entries: unknown[];
					totalSeen: number;
				}>(`(() => {
					const w = window.top || window;
					const all = w.__deep_log || [];
					const offset = w.__deep_log_offset || 0;
					const slice = all.slice(offset);
					w.__deep_log_offset = all.length;
					return { entries: slice, totalSeen: all.length };
				})()`);
				return c.json(result ?? { entries: [], totalSeen: 0 });
			},
		},

		{
			method: 'POST',
			path: '/experiments/clear-logs',
			description: 'EXPERIMENTAL: clear top.__deep_log via CDP main-world evaluate.',
			handler: async (c, browser) => {
				const control = browser.getScriptControl();
				if (!control) return c.json({ error: 'Browser not running.' }, 503);
				const result = await control.evaluateInMainWorld<{ cleared: number }>(`(() => {
					const w = window.top || window;
					const n = (w.__deep_log || []).length;
					w.__deep_log = [];
					w.__deep_log_offset = 0;
					w.__deep_log_seq = 0;
					return { cleared: n };
				})()`);
				return c.json({ ok: true, ...(result ?? { cleared: 0 }) });
			},
		},
	];
}
