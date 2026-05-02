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
// These need to track chatgpt.com's deployed build. If they go stale enough,
// chatgpt's anti-abuse layer flags the requests as "Unusual activity". Refresh
// from a real browser session: open chatgpt.com, watch a /conversation/prepare
// request in DevTools → copy `oai-client-version` and `oai-client-build-number`.
const CLIENT_VERSION = 'prod-4987068829830ddc3ae6683bd4e633f61b79dec9';
const CLIENT_BUILD_NUMBER = '6325146';

/**
 * Per-page mutex so two `sentinelGatedConversation` calls on the same
 * browser page never overlap. chatgpt's anti-abuse layer flags two
 * prepare/conversation pairs from the same `oai-did` within milliseconds
 * as "Unusual activity"; the UI can't submit two messages at once, so
 * we mirror that constraint. Distribution across profiles still
 * happens via `BrowserPool.pick()`'s round-robin upstream.
 */
const conversationTails = new WeakMap<object, Promise<unknown>>();

/**
 * Pre-mint hook for the rate-limit-gate bisection (see
 * docs/HANDOFF-RATE-LIMIT-INVESTIGATION.md).
 *
 * If non-empty, this JS string is `page.evaluate`'d immediately before
 * `SentinelSDK.token('next')` runs. Lets the bisection harness inject
 * behavioral signals (set `window.__oai_so_*`, dispatch synthetic events,
 * etc.) per call without forking `runSubmit`. Set via
 * `POST /experiments/set-pre-mint-script` and cleared by sending an
 * empty body.
 *
 * Lives at module scope (one value per server process) — the bisection
 * runs one variant at a time, so this is sufficient.
 */
let preMintScript = '';

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
		/** Forwarded to the upstream `system_hints` field. ['search'] forces web search. */
		systemHints?: string[];
	} = {},
): Promise<{ status: number; contentType: string | null; body: string }> {
	const page = browser.getPage();
	if (!page) throw new Error('Browser not connected');
	if (!page.url().startsWith('https://chatgpt.com/')) {
		throw new Error(`Browser not on chatgpt.com (currently: ${page.url()})`);
	}

	// Serialize concurrent calls on the same page. Concurrent submits from one
	// `oai-did` look like burst abuse and trip the per-device 403; the UI
	// itself disables the composer between turns, so we mirror that here.
	const prev = conversationTails.get(page) ?? Promise.resolve();
	let resolveTail!: () => void;
	const next = new Promise<void>((res) => {
		resolveTail = res;
	});
	conversationTails.set(
		page,
		prev.then(() => next),
	);
	await prev;
	try {
		return await runSubmit(browser, page, message, opts);
	} finally {
		resolveTail();
	}
}

async function runSubmit(
	browser: RemoteBrowserService,
	page: NonNullable<ReturnType<RemoteBrowserService['getPage']>>,
	message: string,
	opts: {
		model?: string;
		parentMessageId?: string;
		flow?: string;
		messageId?: string;
		systemHints?: string[];
	},
): Promise<{ status: number; contentType: string | null; body: string }> {
	// 1. Pre-mint hook (bisection harness injection point). Runs before the
	//    token mint so it can mutate `window.__oai_so_*` or dispatch synthetic
	//    DOM events whose values get folded into the proof token. Empty by
	//    default.
	if (preMintScript) {
		try {
			await page.evaluate(preMintScript);
		} catch (err) {
			console.warn(
				'[sentinel] preMintScript threw:',
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// 2. Mint tokens. SDK loads on first call; subsequent calls reuse the
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

	// 3. Harvest cookies + device id.
	const cookies = (await page.evaluate(() => document.cookie)) as string;
	const did = (cookies.match(/oai-did=([a-f0-9-]+)/) ?? [])[1] ?? tokens.id ?? '';

	// 4. Per-turn identifiers — turn_trace_id and session_id are SHARED between
	//    /conversation/prepare and /conversation. The chatgpt UI does this and
	//    skipping prepare flags the request as anti-abuse.
	const messageId = opts.messageId ?? crypto.randomUUID();
	const turnTraceId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();

	// Common headers that appear on both /prepare and /conversation. Match the
	// UI as closely as possible — header order is preserved by Bun fetch.
	const baseHeaders: Record<string, string> = {
		'user-agent': CHROME_UA,
		cookie: cookies,
		'content-type': 'application/json',
		'accept-language': 'en-US',
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
		'oai-client-version': CLIENT_VERSION,
		'oai-client-build-number': CLIENT_BUILD_NUMBER,
		'oai-session-id': sessionId,
		'x-oai-turn-trace-id': turnTraceId,
	};

	// 5. POST /conversation/prepare. The body mirrors what the React app
	//    sends on each keystroke — a `partial_query` that represents the
	//    in-flight draft. Response: `{"status":"ok","conduit_token":"<JWT,
	//    60s TTL>"}`. The token is required on the subsequent
	//    /conversation request; without it chatgpt returns "Unusual
	//    activity" 403s and eventually the IP-wide "messages per hour" 429s.
	const prepareBody = {
		action: 'next',
		fork_from_shared_post: false,
		parent_message_id: opts.parentMessageId ?? 'client-created-root',
		model: opts.model ?? 'auto',
		client_prepare_state: 'none',
		timezone_offset_min: 240,
		timezone: 'America/New_York',
		conversation_mode: { kind: 'primary_assistant' },
		system_hints: opts.systemHints ?? [],
		partial_query: {
			id: messageId,
			author: { role: 'user' },
			content: { content_type: 'text', parts: [message] },
		},
		supports_buffering: true,
		supported_encodings: ['v1'],
		client_contextual_info: { app_name: 'chatgpt.com' },
	};
	// Fire /prepare twice with a typing-dwell delay between, mimicking the
	// React app's per-keystroke prepares. A single bare /prepare → /conversation
	// pair fires too tight to look human and trips the per-device 403 on cold
	// profiles. The conduit_token from the LAST /prepare is what we send to
	// /conversation (each /prepare returns a fresh token chained off the prior).
	let conduitToken = 'no-token';
	for (let i = 0; i < 2; i++) {
		if (i > 0) await new Promise((r) => setTimeout(r, 250 + Math.random() * 200));
		const prepareResp = await fetch(`${CHATGPT_BASE}/backend-anon/f/conversation/prepare`, {
			method: 'POST',
			headers: {
				...baseHeaders,
				'x-openai-target-path': '/backend-anon/f/conversation/prepare',
				'x-openai-target-route': '/backend-anon/f/conversation/prepare',
				'x-conduit-token': conduitToken,
			},
			body: JSON.stringify(prepareBody),
		});
		if (prepareResp.ok) {
			try {
				const prepareJson = (await prepareResp.json()) as { conduit_token?: string };
				if (typeof prepareJson.conduit_token === 'string') {
					conduitToken = prepareJson.conduit_token;
				}
			} catch {
				/* if prepare body isn't JSON, fall through with whatever token we have */
			}
		}
	}

	// 6. Build conversation body. `client_prepare_state` is 'success' to match
	//    what the UI sends after a successful /prepare round-trip.
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
		client_prepare_state: 'success',
		timezone_offset_min: 240,
		timezone: 'America/New_York',
		conversation_mode: { kind: 'primary_assistant' },
		enable_message_followups: true,
		system_hints: opts.systemHints ?? [],
		supports_buffering: true,
		supported_encodings: ['v1'],
		client_contextual_info: {
			is_dark_mode: false,
			time_since_loaded: 15,
			page_height: 800,
			page_width: 1280,
			pixel_ratio: 1,
			screen_height: 800,
			screen_width: 1280,
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

	// 7. POST /conversation with the freshly-minted Sentinel tokens + the
	//    conduit_token from /prepare.
	const r = await fetch(`${CHATGPT_BASE}/backend-anon/f/conversation`, {
		method: 'POST',
		headers: {
			...baseHeaders,
			accept: 'text/event-stream',
			'x-openai-target-path': '/backend-api/f/conversation',
			'x-openai-target-route': '/backend-api/f/conversation',
			'oai-echo-logs': '0,1536',
			'oai-telemetry': '[1,null]',
			'x-conduit-token': conduitToken,
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

		{
			method: 'POST',
			path: '/experiments/set-pre-mint-script',
			description:
				'EXPERIMENTAL (rate-limit-gate bisection): set or clear the JS string ' +
				'page.evaluate-d immediately before SentinelSDK.token mints. ' +
				'Body: { script: string }. Empty string clears the hook. Used by ' +
				'experiments/bisect-harness.ts to inject behavioral mutations (V4/V5/V6).',
			browserRequired: false,
			handler: async (c) => {
				let body: { script?: string };
				try {
					body = await c.req.json();
				} catch {
					return c.json({ error: 'Body must be JSON: { script: string }' }, 400);
				}
				preMintScript = typeof body.script === 'string' ? body.script : '';
				return c.json({ ok: true, length: preMintScript.length });
			},
		},

		{
			method: 'GET',
			path: '/experiments/get-pre-mint-script',
			description: 'EXPERIMENTAL: read the current pre-mint hook (length + preview).',
			browserRequired: false,
			handler: async (c) => {
				return c.json({
					length: preMintScript.length,
					preview: preMintScript.slice(0, 200),
				});
			},
		},

		{
			method: 'POST',
			path: '/experiments/keyboard-burst',
			description:
				'EXPERIMENTAL (rate-limit-gate bisection): fire a burst of trusted ' +
				'keyboard + mouse events into the active chatgpt page using ' +
				'`page.keyboard.type` and `page.mouse.move`. This generates ' +
				"`isTrusted: true` events that should drive the Sentinel SDK's " +
				'behavioral counters. Body: { chars?: number, includeMouse?: boolean }.',
			handler: async (c, browser) => {
				const page = browser.getPage();
				if (!page) return c.json({ error: 'Browser not connected.' }, 503);
				let body: { chars?: number; includeMouse?: boolean };
				try {
					body = (await c.req.json().catch(() => ({}))) as typeof body;
				} catch {
					body = {};
				}
				const chars = Math.max(1, Math.min(40, body.chars ?? 8));
				const includeMouse = body.includeMouse !== false;

				// Move mouse a bit (no specific target — just generate movement events).
				if (includeMouse) {
					try {
						const startX = 200 + Math.floor(Math.random() * 600);
						const startY = 200 + Math.floor(Math.random() * 400);
						await page.mouse.move(startX, startY);
						for (let i = 0; i < 4; i++) {
							const dx = startX + Math.floor((Math.random() - 0.5) * 200);
							const dy = startY + Math.floor((Math.random() - 0.5) * 200);
							await page.mouse.move(dx, dy, { steps: 4 });
						}
					} catch {}
				}

				// Type into a hidden offscreen contentEditable so we don't trigger the
				// React composer's /prepare path. We blur it after.
				try {
					await page.evaluate(() => {
						const id = '__bisect_typing_target';
						let el = document.getElementById(id) as HTMLElement | null;
						if (!el) {
							el = document.createElement('div');
							el.id = id;
							el.contentEditable = 'true';
							el.style.cssText =
								'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0';
							document.body.appendChild(el);
						}
						el.focus();
					});
					const sample = 'abcdefghijklmnopqrstuvwxyz';
					let s = '';
					for (let i = 0; i < chars; i++) s += sample[Math.floor(Math.random() * sample.length)];
					await page.keyboard.type(s, { delay: 40 + Math.floor(Math.random() * 80) });
					await page.evaluate(() => {
						const el = document.getElementById('__bisect_typing_target');
						if (el && el instanceof HTMLElement) el.blur();
					});
				} catch (err) {
					return c.json({ ok: false, error: (err as Error).message }, 500);
				}
				return c.json({ ok: true, chars, includeMouse });
			},
		},
	];
}
