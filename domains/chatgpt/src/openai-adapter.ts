/**
 * OpenAI-Compatible Adapter for the ChatGPT Domain
 *
 * Exposes two OpenAI-format endpoints so any OpenAI SDK client (including
 * AnythingLLM's Generic OpenAI provider) can use this proxy as a drop-in
 * replacement:
 *
 *   GET  /api/chatgpt/v1/models
 *   POST /api/chatgpt/v1/chat/completions
 *
 * Configure AnythingLLM with:
 *   Provider:  Generic OpenAI
 *   Base URL:  http://localhost:3001/api/chatgpt/v1
 *   API Key:   any non-empty string (Bearer auth not required for anonymous mode)
 *
 * ANONYMOUS MODE (no login required)
 * ───────────────────────────────────
 * ChatGPT's backend-anon/f/conversation endpoint works without a Bearer token.
 * However, it requires Turnstile + proof-of-work challenges that the page
 * solves automatically. The click-intercept pattern is used:
 *   1. Navigate the existing browser page to a fresh chatgpt.com chat
 *   2. Set up a response interceptor to capture the SSE stream
 *   3. Type the user message and click send
 *   4. Wait for the full SSE response, parse, and return in OpenAI format
 *
 * TRANSLATION NOTES
 * ─────────────────
 * ChatGPT's backend-anon endpoint emits SSE with *cumulative* text — each
 * event contains the full assistant message so far. OpenAI format requires
 * *deltas* — each chunk contains only new text. The adapter diffs consecutive
 * events to produce proper deltas.
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { sentinelGatedConversation } from './routes';

const DEFAULT_MODEL = 'gpt-4o';

// ─── OpenAI request / response types ──────────────────────────────────────

interface OAIMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

interface OAIChatRequest {
	model?: string;
	messages: OAIMessage[];
	stream?: boolean;
	temperature?: number;
	max_tokens?: number;
}

// ─── ChatGPT SSE event shape ───────────────────────────────────────────────

interface ChatGPTSSEEvent {
	message?: {
		id: string;
		author: { role: string };
		content: { content_type: string; parts: string[] };
		status: string;
	};
	conversation_id?: string;
	error?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Parse ChatGPT's cumulative SSE stream → extract the final assistant text.
 *
 * Two encodings observed:
 *   1. Legacy: each `data:` line is `{ message: { author, content: {parts}, … } }`
 *      with the full text-so-far cumulated.
 *   2. v1 delta encoding (current as of 2026-05-01): the stream begins with
 *      `event: delta_encoding\ndata: "v1"`, then each subsequent
 *      `data: { "p": "<json-pointer>", "o": "<add|append|replace|remove>", "v": <value> }`
 *      patches a state object. The first `o:"add"` with `p:""` seeds the
 *      whole document (often containing the assistant message), subsequent
 *      `o:"append"` ops add text deltas at `p:".../parts/0"`.
 *
 * We support both. For v1 we walk the patches and emit the final
 * `message.content.parts.join('')`.
 */
function extractFinalText(rawSSE: string): string {
	const lines = rawSSE.split('\n');

	// Detect encoding
	let isV1 = false;
	for (const line of lines) {
		if (line.startsWith('data: "v1"')) {
			isV1 = true;
			break;
		}
		if (line.startsWith('data: ') && line.includes('"message"')) break; // legacy
	}

	if (!isV1) {
		// Legacy parser
		let lastText = '';
		for (const line of lines) {
			if (!line.startsWith('data: ')) continue;
			const payload = line.slice(6).trim();
			if (payload === '[DONE]') break;
			try {
				const event = JSON.parse(payload) as ChatGPTSSEEvent;
				if (
					event.message?.author?.role === 'assistant' &&
					event.message?.content?.content_type === 'text'
				) {
					const text = event.message.content.parts.join('');
					if (text.length > lastText.length) lastText = text;
				}
			} catch {
				/* skip malformed events */
			}
		}
		return lastText;
	}

	// v1 delta-patch parser. Walk each `data:` payload, apply the patch
	// to a working `doc` object, and at the end return the final
	// assistant text.
	//
	// Wire format observed (three event shapes):
	//   1. Explicit:  {"p": "/message/content/parts/0", "o": "append", "v": "..."}
	//   2. Batch:     {"p": "", "o": "patch", "v": [...sub-patches...]}
	//   3. Shorthand: {"v": "..."} — no `p`, no `o`. Means "apply with the
	//      LAST seen p+o". The server uses this to compress a long stream
	//      of repeated ops to the same path. Without remembering the
	//      previous (p, o), we drop ~90% of the response body.
	let lastAssistantText = '';
	const docState: Record<string, unknown> = {};
	let lastPath = '';
	let lastOp = '';
	for (const line of lines) {
		if (!line.startsWith('data: ')) continue;
		const payload = line.slice(6).trim();
		if (payload === '[DONE]') break;
		if (payload === '"v1"') continue;
		let patch: { p?: string; o?: string; v?: unknown; type?: string };
		try {
			patch = JSON.parse(payload);
		} catch {
			continue;
		}
		if (typeof patch !== 'object' || patch === null) continue;
		if (typeof patch.type === 'string' && patch.v === undefined) continue;
		if (patch.o === 'patch' && Array.isArray(patch.v)) {
			applyPatch(docState, { p: '', o: 'patch', v: patch.v });
		} else if (typeof patch.o === 'string' && typeof patch.p === 'string') {
			applyPatch(docState, patch as { p: string; o: string; v?: unknown });
			lastPath = patch.p;
			lastOp = patch.o;
		} else if (patch.v !== undefined && lastPath && lastOp) {
			// Shorthand event — reuse last (p, o).
			applyPatch(docState, { p: lastPath, o: lastOp, v: patch.v });
		} else if (
			patch.v !== undefined &&
			typeof patch.v === 'object' &&
			patch.v !== null &&
			!Array.isArray(patch.v)
		) {
			// Implicit root merge with object payload (no prior path).
			applyPatch(docState, { p: '', o: 'replace', v: patch.v });
		}
		const msg = (
			docState as {
				message?: { author?: { role?: string }; content?: { parts?: string[] } };
			}
		).message;
		if (msg?.author?.role === 'assistant' && Array.isArray(msg.content?.parts)) {
			const text = msg.content.parts.join('');
			if (text) lastAssistantText = text;
		}
	}
	return lastAssistantText;
}

/**
 * Minimal JSON Pointer-ish patch applier covering the ops ChatGPT emits.
 * Path syntax: dotted, e.g. `/message/content/parts/0` — but ChatGPT's
 * actual emitter uses dotted form like `message.content.parts.0`. We
 * accept both.
 */
function applyPatch(doc: Record<string, unknown>, patch: { p: string; o: string; v?: unknown }) {
	// "patch" op: v is an array of sub-patches to apply in order.
	if (patch.o === 'patch' && Array.isArray(patch.v)) {
		for (const sub of patch.v) {
			if (
				sub &&
				typeof sub === 'object' &&
				typeof (sub as { p?: unknown }).p === 'string' &&
				typeof (sub as { o?: unknown }).o === 'string'
			) {
				applyPatch(doc, sub as { p: string; o: string; v?: unknown });
			}
		}
		return;
	}

	const segments = patch.p
		.replace(/^\//, '')
		.split(/[/.]/)
		.filter((s) => s.length > 0);

	if (segments.length === 0) {
		// Root-level op
		if (patch.o === 'add' || patch.o === 'replace') {
			const v = patch.v;
			if (typeof v === 'object' && v !== null) Object.assign(doc, v);
		}
		return;
	}

	let parent: unknown = doc;
	for (let i = 0; i < segments.length - 1; i++) {
		const seg = segments[i];
		if (typeof parent !== 'object' || parent === null) return;
		// biome-ignore lint/suspicious/noExplicitAny: JSON walk requires dynamic indexing
		const next = (parent as any)[seg];
		if (next === undefined) {
			// biome-ignore lint/suspicious/noExplicitAny: JSON walk requires dynamic indexing
			(parent as any)[seg] = /^\d+$/.test(segments[i + 1] ?? '') ? [] : {};
		}
		// biome-ignore lint/suspicious/noExplicitAny: JSON walk requires dynamic indexing
		parent = (parent as any)[seg];
	}
	const tail = segments[segments.length - 1];
	if (typeof parent !== 'object' || parent === null) return;
	// biome-ignore lint/suspicious/noExplicitAny: JSON walk requires dynamic indexing
	const target = parent as any;

	if (patch.o === 'add' || patch.o === 'replace') {
		target[tail] = patch.v;
	} else if (patch.o === 'append') {
		const existing = target[tail];
		if (typeof existing === 'string' && typeof patch.v === 'string') {
			target[tail] = existing + patch.v;
		} else if (Array.isArray(existing)) {
			existing.push(patch.v);
		} else if (typeof patch.v === 'string') {
			target[tail] = patch.v;
		} else if (
			typeof existing === 'object' &&
			existing !== null &&
			typeof patch.v === 'object' &&
			patch.v !== null
		) {
			// Merge object append (e.g. metadata fields).
			Object.assign(existing as Record<string, unknown>, patch.v);
		}
	} else if (patch.o === 'remove') {
		delete target[tail];
	}
}

/**
 * Parse ChatGPT's cumulative SSE stream and yield OpenAI-format delta chunks.
 *
 * For the v1 delta-encoded stream the simple-but-correct path is to walk
 * the patches into a working doc, then diff the resulting text against
 * what we've already emitted. We do this in one pass per `data:` line so
 * the user sees deltas as they arrive (when consumed via streaming).
 */
function* toOpenAIChunks(rawSSE: string, completionId: string, model: string): Generator<string> {
	const lines = rawSSE.split('\n');

	// Detect encoding (same heuristic as extractFinalText).
	let isV1 = false;
	for (const line of lines) {
		if (line.startsWith('data: "v1"')) {
			isV1 = true;
			break;
		}
		if (line.startsWith('data: ') && line.includes('"message"')) break;
	}

	let prevText = '';
	const doc: Record<string, unknown> = {};
	let lastPath = '';
	let lastOp = '';

	for (const line of lines) {
		if (!line.startsWith('data: ')) continue;
		const payload = line.slice(6).trim();

		if (payload === '[DONE]') {
			const finishChunk = {
				id: completionId,
				object: 'chat.completion.chunk',
				created: Math.floor(Date.now() / 1000),
				model,
				choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
			};
			yield `data: ${JSON.stringify(finishChunk)}\n\n`;
			yield 'data: [DONE]\n\n';
			return;
		}
		if (payload === '"v1"') continue;

		let currentText = '';
		if (isV1) {
			try {
				const patch = JSON.parse(payload) as {
					p?: string;
					o?: string;
					v?: unknown;
					type?: string;
				};
				if (patch === null || typeof patch !== 'object') continue;
				if (typeof patch.type === 'string' && patch.v === undefined) continue;
				if (patch.o === 'patch' && Array.isArray(patch.v)) {
					applyPatch(doc, { p: '', o: 'patch', v: patch.v });
				} else if (typeof patch.o === 'string' && typeof patch.p === 'string') {
					applyPatch(doc, patch as { p: string; o: string; v?: unknown });
					lastPath = patch.p;
					lastOp = patch.o;
				} else if (patch.v !== undefined && lastPath && lastOp) {
					// Shorthand event — reuse last (p, o).
					applyPatch(doc, { p: lastPath, o: lastOp, v: patch.v });
				} else if (
					patch.v !== undefined &&
					typeof patch.v === 'object' &&
					patch.v !== null &&
					!Array.isArray(patch.v)
				) {
					applyPatch(doc, { p: '', o: 'replace', v: patch.v });
				} else {
					continue;
				}
				const msg = (
					doc as {
						message?: { author?: { role?: string }; content?: { parts?: string[] } };
					}
				).message;
				if (msg?.author?.role === 'assistant' && Array.isArray(msg.content?.parts)) {
					currentText = msg.content.parts.join('');
				}
			} catch {
				continue;
			}
		} else {
			let event: ChatGPTSSEEvent;
			try {
				event = JSON.parse(payload);
			} catch {
				continue;
			}
			if (event.error) continue;
			if (event.message?.author?.role !== 'assistant') continue;
			if (event.message?.content?.content_type !== 'text') continue;
			currentText = event.message.content.parts.join('');
		}

		const delta = currentText.slice(prevText.length);
		if (delta.length === 0) continue;
		prevText = currentText;

		const chunk = {
			id: completionId,
			object: 'chat.completion.chunk',
			created: Math.floor(Date.now() / 1000),
			model,
			choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
		};
		yield `data: ${JSON.stringify(chunk)}\n\n`;
	}
}

// ─── Routes ───────────────────────────────────────────────────────────────

export const openaiAdapterRoutes: DomainRoute[] = [
	// ── GET /v1/models ────────────────────────────────────────────────

	{
		method: 'GET',
		path: '/v1/models',
		description:
			'OpenAI-compatible model list. Set as base URL in AnythingLLM: http://localhost:3001/api/chatgpt/v1',
		browserRequired: false,
		handler: async (c) => {
			const created = 1_699_000_000;
			return c.json({
				object: 'list',
				data: [
					{ id: 'gpt-4o', object: 'model', created, owned_by: 'chatgpt-proxy' },
					{ id: 'gpt-4o-mini', object: 'model', created, owned_by: 'chatgpt-proxy' },
					{ id: 'gpt-4.5-preview', object: 'model', created, owned_by: 'chatgpt-proxy' },
					{ id: 'o1', object: 'model', created, owned_by: 'chatgpt-proxy' },
					{ id: 'o3', object: 'model', created, owned_by: 'chatgpt-proxy' },
					{ id: 'o4-mini', object: 'model', created, owned_by: 'chatgpt-proxy' },
				],
			});
		},
	},

	// ── POST /v1/chat/completions ─────────────────────────────────────

	{
		method: 'POST',
		path: '/v1/chat/completions',
		description:
			'OpenAI-compatible chat completions. Mints per-message Sentinel tokens ' +
			"via the page's SentinelSDK and POSTs `/backend-anon/f/conversation` " +
			'directly via Bun fetch (no UI driving — concurrent calls supported).',
		handler: async (c, browser) => {
			// ── Parse request ──────────────────────────────────────────────
			let body: OAIChatRequest;
			try {
				body = await c.req.json();
			} catch {
				return c.json(
					{ error: { message: 'Request body must be JSON', type: 'invalid_request_error' } },
					400,
				);
			}

			if (!body.messages || body.messages.length === 0) {
				return c.json(
					{ error: { message: 'messages is required', type: 'invalid_request_error' } },
					400,
				);
			}

			// Use the last user message as the prompt. (Multi-turn conversation
			// state isn't preserved server-side because each call is a fresh
			// chatgpt.com submission — the conversation_id from prior responses
			// would let us thread, but that's a separate enhancement.)
			const lastUserMsg =
				[...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

			if (!lastUserMsg) {
				return c.json(
					{ error: { message: 'No user message found', type: 'invalid_request_error' } },
					400,
				);
			}

			const model = body.model ?? DEFAULT_MODEL;
			const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 28)}`;

			const page = browser.getPage();
			if (!page) {
				return c.json(
					{ error: { message: 'Browser page not available', type: 'server_error' } },
					503,
				);
			}
			if (!page.url().startsWith('https://chatgpt.com/')) {
				return c.json(
					{
						error: {
							message: 'Browser is not on chatgpt.com.',
							type: 'server_error',
							currentUrl: page.url(),
						},
					},
					412,
				);
			}

			let result: { status: number; contentType: string | null; body: string };
			try {
				result = await sentinelGatedConversation(browser, lastUserMsg);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return c.json(
					{
						error: { message: 'sentinel-gated submit failed', type: 'upstream_error', detail: msg },
					},
					502,
				);
			}

			if (result.status !== 200) {
				return c.json(
					{
						error: {
							message: `Upstream error: HTTP ${result.status}`,
							type: 'upstream_error',
							detail: result.body.slice(0, 400),
						},
					},
					502,
				);
			}

			const rawSSE = result.body;

			// ── Streaming response (default) ─────────────────────────────────
			if (body.stream !== false) {
				const stream = new ReadableStream({
					start(controller) {
						const enc = new TextEncoder();
						// Role chunk so the client knows what role the deltas belong to.
						const roleChunk = {
							id: completionId,
							object: 'chat.completion.chunk',
							created: Math.floor(Date.now() / 1000),
							model,
							choices: [
								{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null },
							],
						};
						controller.enqueue(enc.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));
						for (const chunk of toOpenAIChunks(rawSSE, completionId, model)) {
							controller.enqueue(enc.encode(chunk));
						}
						controller.close();
					},
				});
				return new Response(stream, {
					status: 200,
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						'X-Accel-Buffering': 'no',
					},
				});
			}

			// ── Non-streaming response ─────────────────────────────────
			const fullText = extractFinalText(rawSSE);
			if (!fullText) {
				return c.json(
					{
						error: {
							message: 'No text content in ChatGPT response',
							type: 'upstream_error',
						},
					},
					502,
				);
			}
			return c.json({
				id: completionId,
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model,
				choices: [
					{
						index: 0,
						message: { role: 'assistant', content: fullText },
						finish_reason: 'stop',
					},
				],
				usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
			});
		},
	},
];
