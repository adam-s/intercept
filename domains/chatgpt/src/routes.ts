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
import { ChatGPTScriptInterceptor } from './fingerprint';
import { ChatGPTSessionManager } from './session';
import type { ChatGPTInterceptorMode, FingerprintProfile } from './types';

const CHATGPT_BASE = 'https://chatgpt.com';
const DEFAULT_MODEL = 'gpt-4o';

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
		description: 'Proxy chatgpt.com conversation API — streams SSE response.',
		handler: async (c, browser) => {
			const session = ChatGPTSessionManager.getInstance();

			if (!session.getAccessToken()) {
				return c.json(
					{ error: 'No access token. Call POST /api/chatgpt/session/harvest first.' },
					401,
				);
			}

			let body: {
				message?: string;
				model?: string;
				conversationId?: string;
				parentMessageId?: string;
			};
			try {
				body = await c.req.json();
			} catch {
				return c.json({ error: 'Request body must be JSON' }, 400);
			}

			if (!body.message) {
				return c.json({ error: 'message is required' }, 400);
			}

			const messageId = crypto.randomUUID();
			const parentId = body.parentMessageId ?? crypto.randomUUID();

			const conversationPayload = {
				action: 'next',
				messages: [
					{
						id: messageId,
						author: { role: 'user' },
						create_time: Date.now() / 1000,
						content: { content_type: 'text', parts: [body.message] },
					},
				],
				model: body.model ?? DEFAULT_MODEL,
				parent_message_id: parentId,
				...(body.conversationId ? { conversation_id: body.conversationId } : {}),
				timezone_offset_minutes: new Date().getTimezoneOffset(),
				history_and_training_disabled: false,
			};

			const apiUrl = `${CHATGPT_BASE}/backend-api/conversation`;

			// browserFetch carries the browser's session cookies + WAF tokens
			const result = await browser.browserFetch<string>(apiUrl, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${session.getAccessToken()}`,
					'Content-Type': 'application/json',
					Accept: 'text/event-stream',
					'OpenAI-Sentinel-Chat-Requirements-Token': 'null',
				},
				body: conversationPayload,
			});

			// The upstream response is an SSE stream. Forward it as-is.
			const sseText = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);

			return new Response(sseText, {
				status: result.status,
				headers: {
					'Content-Type': 'text/event-stream',
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
			if (!page) {
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
			await interceptor.attach(page);

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
];
