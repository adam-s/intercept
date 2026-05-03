/**
 * Build Nvidia Domain Routes — browserless proxy for build.nvidia.com
 *
 * Discovery (2026-05-02): every read endpoint backing the public NIM
 * catalog (build.nvidia.com) is anonymous and CDN-cached. The chat
 * playground at /<vendor>/<model> wraps a captcha-gated transport,
 * but the same models are also reachable through NVIDIA's official
 * `integrate.api.nvidia.com` Bearer-token API. So this plugin's
 * route surface is fully browserless:
 *
 *   GET  /catalog                        — full ENDPOINT catalog (~164 models)
 *   GET  /catalog/labelsets              — filter labelsets (categories, providers)
 *   GET  /models/:vendor/:slug/spec      — OpenAPI spec + parsed playground config
 *   GET  /models/:vendor/:slug/partner-endpoints — partner cloud providers
 *   GET  /killswitches/:scope/:name      — runtime feature flags / config
 *   GET  /publishers/:publisher/logo     — partner brand logo URL
 *   POST /chat/completions               — OpenAI-compatible bearer-passthrough
 *                                          to integrate.api.nvidia.com/v1
 *   POST /chat/completions/browser       — UI-driven chat via the playground
 *                                          (no API key — needs a connected
 *                                          browser session; single-flight)
 *
 * The vendor segment in /models/:vendor/:slug is part of the human-
 * readable URL on build.nvidia.com but is not used in the upstream API
 * (which keys by bare slug under a fixed org `qc69jvmznzxy`).
 *
 * @module domain-build-nvidia/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import type { InitScriptHandle, RemoteBrowserService } from '@interceptor/browser/remote';
import { DEBUG, rateLimitedFetch } from '@interceptor/shared';
import {
	browserDrivenChat,
	browserDrivenChatCapture,
	type CapturedPredictPost,
	captureUnburned,
} from './browser-chat';
import {
	captureHCaptchaPostMessages,
	mintTokenFromFrame,
	NVIDIA_SITEKEY,
	pollHCaptchaPostMessages,
	probeHCaptchaFrame,
} from './captcha-frame';
import { buildBuildNvidiaFingerprintScript } from './fingerprint-script';
import { BuildNvidiaInstrument } from './instrument';
import { type ReplayOptions, replayPredict, replayPredictStreaming } from './replay';
import {
	attachRuntimeTap,
	detachRuntimeTap,
	drainRuntimeTap,
	type RuntimeTapEntry,
} from './runtime-tap';
import { getBundleCapture, startBundleCapture, stopBundleCapture } from './script-capture';

/** Singleton — one active instrumentation per server. */
let instrument: BuildNvidiaInstrument | null = null;
/** Singleton — one active runtime-tap per server. */
let runtimeTapHandle: InitScriptHandle | null = null;
/** Persona init script — installed on first browser-driven chat call. The
 *  script's `__bn_fp_installed` IIFE guard makes re-installs idempotent. */
let fingerprintHandle: InitScriptHandle | null = null;
let fingerprintAttachedFor: RemoteBrowserService | null = null;

/**
 * Install the build-nvidia persona init script on this browser session if
 * not already done. The persona masks the headless-fingerprint surface
 * hCaptcha invisible mode reads (~70 properties per d4c5d1e0/hcaptcha).
 *
 * The script's `__bn_fp_installed` guard means re-execution in already-
 * patched realms is a no-op, so it is safe to call this on every chat
 * request — only the first one does real work.
 *
 * Headed mode does not need this — real Chrome already passes hCaptcha —
 * but we install unconditionally because it costs nothing and helps any
 * marginal headless-shell bleed-through.
 */
async function ensurePersona(browser: RemoteBrowserService): Promise<boolean> {
	if (fingerprintAttachedFor === browser && fingerprintHandle) return false;
	const control = browser.getScriptControl();
	if (!control) return false;
	fingerprintHandle = await control.registerInitScript(buildBuildNvidiaFingerprintScript());
	fingerprintAttachedFor = browser;
	DEBUG('build-nvidia', 'persona init script installed for this browser session');
	return true;
}

/** E1 experiment state: the most recent predict POST captured by
 *  /debug/capture-predict, available for replay via /debug/replay-predict. */
let lastCapturedPredict: CapturedPredictPost | null = null;

const NGC_API = 'https://api.ngc.nvidia.com/v2';
const BUILD_API = 'https://build.nvidia.com/api';
const INTEGRATE_API = 'https://integrate.api.nvidia.com/v1';

/** NVIDIA's public NIM tenant on api.ngc.nvidia.com — same value across all models. */
const NIM_ORG = 'qc69jvmznzxy';

const UA_HEADER: Record<string, string> = {
	'User-Agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
};

interface CatalogResource {
	resourceId: string;
	orgName: string;
	displayName: string;
	name: string;
	description: string;
	resourceType: 'ENDPOINT';
	dateCreated: string;
	dateModified: string;
	guestAccess: boolean;
	isPublic: boolean;
	labels: Array<{ key: string; values: string[]; unresolvedValues?: string[] }>;
	attributes: Array<{ key: string; value: string }>;
}

interface CatalogResponse {
	resultTotal: number;
	resultPageTotal: number;
	results: Array<{ groupValue: string; totalCount: number; resources: CatalogResource[] }>;
}

/** Flatten a catalog resource's labels into a single map for easier consumption. */
function summarizeResource(r: CatalogResource): Record<string, unknown> {
	const labels: Record<string, string[]> = {};
	for (const l of r.labels) labels[l.key] = l.values;
	const attrs: Record<string, string> = {};
	for (const a of r.attributes) attrs[a.key] = a.value;
	const publisher = labels.publisher?.[0];
	const slug = r.resourceId.split('/').pop() ?? r.name;
	return {
		slug,
		path: publisher ? `/${publisher}/${slug}` : `/${slug}`,
		publisher: publisher ?? null,
		displayName: r.displayName,
		description: r.description,
		labels: labels.general ?? [],
		logo: attrs.logo ?? null,
		available: attrs.AVAILABLE === 'true',
		preview: attrs.PREVIEW === 'true',
		guestAccess: r.guestAccess,
		dateCreated: r.dateCreated,
		dateModified: r.dateModified,
	};
}

export const routes: DomainRoute[] = [
	// ─── /catalog ────────────────────────────────────────────────────
	{
		method: 'GET',
		path: '/catalog',
		description:
			'Full NVIDIA NIM endpoint catalog (~164 models). Browserless. ?raw=1 returns upstream shape, ?pageSize=N overrides the default 1000.',
		browserRequired: false,
		handler: async (c) => {
			const url = new URL(c.req.url);
			const raw = url.searchParams.get('raw') === '1';
			const pageSize = Number(url.searchParams.get('pageSize') ?? 1000);
			const page = Number(url.searchParams.get('page') ?? 0);

			const q = JSON.stringify({
				orderBy: [{ field: 'dateCreated', value: 'DESC' }],
				page,
				pageSize,
				query: `orgName:"${NIM_ORG}"`,
				scoredSize: pageSize,
			});

			const upstream = `${NGC_API}/search/catalog/resources/ENDPOINT?q=${encodeURIComponent(q)}`;
			DEBUG('build-nvidia', `catalog: ${upstream}`);
			const res = await rateLimitedFetch(upstream, { headers: UA_HEADER });
			if (!res.ok) return c.json({ error: `Upstream ${res.status}` }, 502);
			const data = (await res.json()) as CatalogResponse;
			if (raw) return c.json(data);

			const group = data.results.find((g) => g.groupValue === 'ENDPOINT') ?? data.results[0];
			const models = (group?.resources ?? []).map(summarizeResource);
			return c.json({ total: data.resultTotal, pages: data.resultPageTotal, models });
		},
	},

	// ─── /catalog/labelsets ──────────────────────────────────────────
	{
		method: 'GET',
		path: '/catalog/labelsets',
		description: 'Filter categories (modality, provider, capability) used by the catalog.',
		browserRequired: false,
		handler: async (c) => {
			const res = await rateLimitedFetch(`${NGC_API}/search/labelsets?resource-type=ENDPOINT`, {
				headers: UA_HEADER,
			});
			if (!res.ok) return c.json({ error: `Upstream ${res.status}` }, 502);
			return c.json(await res.json());
		},
	},

	// ─── /models/:vendor/:slug/spec ──────────────────────────────────
	{
		method: 'GET',
		path: '/models/:vendor/:slug/spec',
		description:
			'Per-model spec: OpenAPI 3.1 chat-completions schema, nvcfFunctionId, playground config (features, image/video limits, reasoning), terms-of-use, deploy snippets.',
		browserRequired: false,
		handler: async (c) => {
			const { slug } = c.req.param() as { vendor: string; slug: string };
			const url = `${NGC_API}/endpoints/${NIM_ORG}/${encodeURIComponent(slug)}/spec`;
			const res = await rateLimitedFetch(url, { headers: UA_HEADER });
			if (!res.ok)
				return c.json({ error: `Upstream ${res.status}` }, res.status === 404 ? 404 : 502);

			const raw = (await res.json()) as {
				openAPISpec?: string | unknown;
				attributes?: string;
				nvcfFunctionId?: string;
				namespace?: string;
				artifactName?: string;
			};
			const openAPI =
				typeof raw.openAPISpec === 'string' ? JSON.parse(raw.openAPISpec) : raw.openAPISpec;
			const attributes =
				typeof raw.attributes === 'string' ? JSON.parse(raw.attributes) : raw.attributes;
			return c.json({
				slug: raw.artifactName,
				namespace: raw.namespace,
				nvcfFunctionId: raw.nvcfFunctionId,
				openAPI,
				attributes,
			});
		},
	},

	// ─── /models/:vendor/:slug/partner-endpoints ─────────────────────
	{
		method: 'GET',
		path: '/models/:vendor/:slug/partner-endpoints',
		description:
			'Partner cloud providers (Together AI, Bitdeer, GMI Cloud, Deep Infra, Vultr) hosting the same model.',
		browserRequired: false,
		handler: async (c) => {
			const { slug } = c.req.param() as { vendor: string; slug: string };
			const url = `${NGC_API}/build/endpoints/${NIM_ORG}/${encodeURIComponent(slug)}/partner-endpoints`;
			const res = await rateLimitedFetch(url, { headers: UA_HEADER });
			if (!res.ok)
				return c.json({ error: `Upstream ${res.status}` }, res.status === 404 ? 404 : 502);
			return c.json(await res.json());
		},
	},

	// ─── /killswitches/:scope/:name ──────────────────────────────────
	// Names look like: chat/omit-tools.yaml, kimi-k2.6/playground.enabled,
	// station/page-private.enabled. Some return JSON, some YAML — we pass
	// content-type through and try-parse JSON.
	{
		method: 'GET',
		path: '/killswitches/:scope/:name',
		description:
			'Runtime feature flag passthrough (build.nvidia.com/api/runtime/killswitches/<scope>/<name>).',
		browserRequired: false,
		handler: async (c) => {
			const { scope, name } = c.req.param() as { scope: string; name: string };
			const url = `${BUILD_API}/runtime/killswitches/${encodeURIComponent(scope)}/${encodeURIComponent(name)}`;
			const res = await rateLimitedFetch(url, { headers: UA_HEADER });
			if (!res.ok)
				return c.json({ error: `Upstream ${res.status}` }, res.status === 404 ? 404 : 502);
			const body = await res.text();
			try {
				return c.json(JSON.parse(body));
			} catch {
				return new Response(body, {
					status: 200,
					headers: { 'Content-Type': res.headers.get('content-type') ?? 'text/plain' },
				});
			}
		},
	},

	// ─── /publishers/:publisher/logo ─────────────────────────────────
	{
		method: 'GET',
		path: '/publishers/:publisher/logo',
		description: 'Partner publisher brand-logo URL (returns the asset URL string).',
		browserRequired: false,
		handler: async (c) => {
			const { publisher } = c.req.param() as { publisher: string };
			const res = await rateLimitedFetch(
				`${BUILD_API}/images?publisher=${encodeURIComponent(publisher)}`,
				{ headers: UA_HEADER },
			);
			if (!res.ok) return c.json({ error: `Upstream ${res.status}` }, 502);
			const url = (await res.json()) as string;
			return c.json({ publisher, url });
		},
	},

	// ─── POST /chat/completions ──────────────────────────────────────
	// OpenAI-compatible Bearer passthrough to NVIDIA's official API.
	// User supplies their own `nvapi-…` key via Authorization header
	// (or via the `NVIDIA_API_KEY` env var as a fallback).
	// Streaming responses are piped straight through.
	{
		method: 'POST',
		path: '/chat/completions',
		description:
			'OpenAI-compatible chat completions for ANY NVIDIA NIM model. Pass `Authorization: Bearer nvapi-…` (or set NVIDIA_API_KEY env). Supports streaming via `stream: true`. Browserless.',
		browserRequired: false,
		handler: async (c) => {
			const incomingAuth = c.req.header('authorization');
			const envKey = process.env.NVIDIA_API_KEY;
			const auth = incomingAuth ?? (envKey ? `Bearer ${envKey}` : undefined);
			if (!auth) {
				return c.json(
					{
						error: 'Missing credentials',
						hint: 'Set NVIDIA_API_KEY env var or send Authorization: Bearer nvapi-… header. Get a key at https://build.nvidia.com/explore/discover.',
					},
					401,
				);
			}

			let body: string;
			try {
				body = JSON.stringify(await c.req.json());
			} catch {
				return c.json({ error: 'Invalid JSON body' }, 400);
			}

			const upstream = await rateLimitedFetch(`${INTEGRATE_API}/chat/completions`, {
				method: 'POST',
				headers: {
					...UA_HEADER,
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
					Authorization: auth,
				},
				body,
			});

			const ct = upstream.headers.get('content-type') ?? 'application/json';
			const headers: Record<string, string> = {
				'Content-Type': ct,
				'Cache-Control': 'no-cache',
			};
			if (ct.includes('text/event-stream')) headers['X-Accel-Buffering'] = 'no';
			return new Response(upstream.body, { status: upstream.status, headers });
		},
	},

	// ─── POST /chat/completions/browser ──────────────────────────────
	// UI-driven chat via the public playground. No API key required —
	// the browser mints a fresh single-use hCaptcha token per request.
	// Single-flight per page (the UI itself disables Send between turns).
	// Returns the upstream SSE body buffered (not chunk-streamed).
	{
		method: 'POST',
		path: '/chat/completions/browser',
		description:
			'OpenAI-shaped chat completions driven through the build.nvidia.com playground UI. No NVIDIA_API_KEY needed but a connected browser session IS required. Single-flight per page; response is OpenAI-format SSE buffered to one body. Body: { model: "<vendor>/<slug>", messages: [{role,content}, ...] }.',
		handler: async (c, browser) => {
			let body: { model?: unknown; messages?: unknown };
			try {
				body = (await c.req.json()) as typeof body;
			} catch {
				return c.json({ error: 'Invalid JSON body' }, 400);
			}
			if (typeof body.model !== 'string' || !body.model.includes('/')) {
				return c.json(
					{ error: "Field 'model' must be a vendor-prefixed slug like 'openai/gpt-oss-20b'." },
					400,
				);
			}
			if (!Array.isArray(body.messages) || body.messages.length === 0) {
				return c.json(
					{ error: "Field 'messages' must be a non-empty array of {role, content}." },
					400,
				);
			}

			// The playground UI is single-message single-turn — flatten any
			// system messages onto the latest user message.
			const msgs = body.messages as Array<{ role?: unknown; content?: unknown }>;
			const sys = msgs
				.filter((m) => m.role === 'system' && typeof m.content === 'string')
				.map((m) => String(m.content))
				.join('\n\n');
			const lastUser = [...msgs]
				.reverse()
				.find((m) => m.role === 'user' && typeof m.content === 'string');
			if (!lastUser) return c.json({ error: 'No user message found' }, 400);
			const message = sys
				? `${sys}\n\n${lastUser.content as string}`
				: (lastUser.content as string);

			DEBUG('build-nvidia', `browser chat: ${body.model} (${message.length} chars)`);
			// Install the persona before driving the chat. Init scripts only
			// fire on FUTURE document loads — so if we just registered the
			// persona for the first time but the page is already on the
			// target URL, force a reload so the persona's overrides apply
			// before hCaptcha's bundle reads navigator/screen/WebGL.
			const personaInstalled = await ensurePersona(browser);
			if (personaInstalled) {
				const page = browser.getPage();
				if (page && page.url().startsWith('https://build.nvidia.com')) {
					DEBUG('build-nvidia', 'persona freshly installed; reloading page so it takes effect');
					await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
				}
			}
			let result: Awaited<ReturnType<typeof browserDrivenChat>>;
			try {
				result = await browserDrivenChat(browser, { model: body.model, message });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ error: msg }, 502);
			}
			return new Response(result.body, {
				status: result.status || 200,
				headers: {
					'Content-Type': result.contentType || 'text/event-stream',
					'Cache-Control': 'no-cache',
					'X-Accel-Buffering': 'no',
				},
			});
		},
	},

	// ─── POST /chat/completions/browserless ──────────────────────────
	// Hybrid: a one-time browser per server lifetime mints a fresh
	// hCaptcha token (page.route aborts the browser's outgoing POST
	// before NVIDIA sees it), then we send the actual chat completion
	// from Bun fetch with just 3 headers. The browser is reduced to a
	// token factory; transport is pure Node, true SSE streaming end-to-
	// end. ~2s/mint at steady state (E3 measurement).
	//
	// Per E2 elimination, the minimum required surface for the predict
	// POST is { nv-captcha-token, nv-function-id, content-type }. No
	// cookies, Origin, Referer, UA, or sec-ch-ua-* needed.
	{
		method: 'POST',
		path: '/chat/completions/browserless',
		description:
			'OpenAI-shaped chat completions via the hybrid mint-then-replay path. Browser mints a fresh hCaptcha token via page.route abort; Bun fetches the chat completion endpoint directly. True streaming. Same body shape as /chat/completions/browser. Browser still required at server boot, but the per-request transport is pure Node.',
		handler: async (c, browser) => {
			let body: { model?: unknown; messages?: unknown };
			try {
				body = (await c.req.json()) as typeof body;
			} catch {
				return c.json({ error: 'Invalid JSON body' }, 400);
			}
			if (typeof body.model !== 'string' || !body.model.includes('/')) {
				return c.json(
					{ error: "Field 'model' must be a vendor-prefixed slug like 'openai/gpt-oss-20b'." },
					400,
				);
			}
			if (!Array.isArray(body.messages) || body.messages.length === 0) {
				return c.json({ error: "Field 'messages' must be a non-empty array." }, 400);
			}

			DEBUG('build-nvidia', `browserless chat: ${body.model}`);

			// 1. Ensure persona; reload if newly installed (so it takes effect).
			const personaInstalled = await ensurePersona(browser);
			if (personaInstalled) {
				const page = browser.getPage();
				if (page && page.url().startsWith('https://build.nvidia.com')) {
					await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
				}
			}

			// 2. Mint a fresh un-burned token via the browser. The placeholder
			//    message is throwaway — tokens aren't body-bound (E2.4).
			let captured: CapturedPredictPost;
			try {
				captured = await captureUnburned(browser, {
					model: body.model,
					message: '_',
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ error: `Token mint failed: ${msg}` }, 502);
			}

			// 3. Build the real chat completion body using the user's messages,
			//    matching the playground's request shape.
			const realBody = JSON.stringify({
				reasoning_effort: 'medium',
				stream: true,
				model: body.model,
				max_tokens: 4096,
				presence_penalty: 0,
				frequency_penalty: 0,
				top_p: 1,
				temperature: 1,
				messages: body.messages,
			});

			// 4. Send from Bun fetch with the minimum required headers. The
			//    route abort in captureUnburned is racy ~20% of the time (the
			//    browser's POST occasionally beats the abort and burns the
			//    token); on "Token is invalid" we transparently re-mint once.
			const sendOnce = async (cap: CapturedPredictPost): Promise<Response> => {
				return replayPredictStreaming(cap, {
					body: realBody,
					headerAllowlist: ['nv-captcha-token', 'nv-function-id', 'content-type'],
					headerOverrides: { 'content-type': 'application/json' },
				});
			};

			let upstream: Response;
			try {
				upstream = await sendOnce(captured);
				if (upstream.status === 400) {
					// Read the body to check error code; if it's a token issue, re-mint.
					const errText = await upstream.text();
					if (errText.includes('Token is invalid') || errText.includes('Captcha required')) {
						DEBUG('build-nvidia', `browserless: token rejected, re-minting once`);
						const fresh = await captureUnburned(browser, {
							model: body.model,
							message: '_',
						});
						upstream = await sendOnce(fresh);
					} else {
						// Non-token 400 — surface as-is.
						return c.json({ error: errText }, 400);
					}
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ error: `Bun replay failed: ${msg}` }, 502);
			}

			return new Response(upstream.body, {
				status: upstream.status,
				headers: {
					'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
					'Cache-Control': 'no-cache',
					'X-Accel-Buffering': 'no',
				},
			});
		},
	},

	// ─── DEBUG: hCaptcha frame probing ───────────────────────────────
	// Phase 2 of docs/HCAPTCHA-VS-TURNSTILE.md — diagnose whether
	// Patchright's frame.evaluate gives us reach into the hCaptcha
	// OOPIF, and whether window.hcaptcha is exposed inside it.
	{
		method: 'GET',
		path: '/debug/captcha/frame',
		description:
			'Probe the hCaptcha iframe. Returns: list of all frames on the page, the hCaptcha frame URL (if found), and the result of evaluating `typeof window.hcaptcha` inside it.',
		handler: async (c, browser) => {
			const r = await probeHCaptchaFrame(browser);
			return c.json(r);
		},
	},

	// Attempt to mint a token directly from the iframe SDK. Sitekey
	// defaults to NVIDIA's; pass ?sitekey=... to override.
	{
		method: 'POST',
		path: '/debug/captcha/mint',
		description:
			'Attempt to mint a fresh hCaptcha token by calling `hcaptcha.execute(sitekey, {async:true})` directly inside the iframe via Patchright frame.evaluate. Returns the token (or error). NO UI driving.',
		handler: async (c, browser) => {
			const sitekey = new URL(c.req.url).searchParams.get('sitekey') ?? NVIDIA_SITEKEY;
			DEBUG('build-nvidia', `frame mint: sitekey=${sitekey}`);
			try {
				const r = await mintTokenFromFrame(browser, sitekey);
				return c.json(r);
			} catch (err) {
				return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
			}
		},
	},

	// Install a parent-side postMessage listener for hCaptcha origins.
	// Use this BEFORE driving Send to capture the iframe→parent token-
	// delivery protocol. ?windowMs=30000 sets capture window (default 30s).
	{
		method: 'POST',
		path: '/debug/captcha/pm/start',
		description:
			'Start capturing window.postMessage events from hCaptcha origins on the parent page. Returns a tag to use with /pm/poll. Capture self-tears-down after windowMs (default 30000).',
		handler: async (c, browser) => {
			const windowMs = Number(new URL(c.req.url).searchParams.get('windowMs') ?? 30_000);
			const r = await captureHCaptchaPostMessages(browser, windowMs);
			return c.json(r);
		},
	},

	{
		method: 'GET',
		path: '/debug/captcha/pm/poll',
		description:
			'Drain captured postMessage events for ?tag=... returned by /pm/start. Idempotent — same tag can be polled repeatedly.',
		handler: async (c, browser) => {
			const tag = new URL(c.req.url).searchParams.get('tag');
			if (!tag) return c.json({ ok: false, error: 'Missing ?tag=' }, 400);
			const r = await pollHCaptchaPostMessages(browser, tag);
			return c.json(r);
		},
	},

	// ─── DEBUG: bundle capture (CDP Fetch.requestPaused) ─────────────
	// Dump every script served from hCaptcha + NVIDIA's Next bundle
	// to disk for offline grep. Read-only — bytes never modified.
	{
		method: 'POST',
		path: '/debug/bundles/start',
		description:
			'Start capturing scripts from *newassets.hcaptcha.com*, *api.hcaptcha.com*, and *build.nvidia.com/_next/static/chunks/* into /tmp/build-nvidia-bundles/<tag>/. Returns the tag and dump dir.',
		handler: async (c, browser) => {
			const tag = new URL(c.req.url).searchParams.get('tag') ?? `bn-${Date.now()}`;
			const r = await startBundleCapture(browser, tag);
			return c.json(r);
		},
	},

	{
		method: 'GET',
		path: '/debug/bundles/list',
		description: 'List captured scripts for ?tag=... — URL, size, on-disk path, status.',
		handler: async (c) => {
			const tag = new URL(c.req.url).searchParams.get('tag');
			if (!tag) return c.json({ ok: false, error: 'Missing ?tag=' }, 400);
			const s = getBundleCapture(tag);
			if (!s) return c.json({ ok: false, error: `No capture for tag ${tag}` }, 404);
			return c.json({ ok: true, dumpDir: s.dumpDir, captured: s.captured });
		},
	},

	{
		method: 'POST',
		path: '/debug/bundles/stop',
		description: 'Stop capturing for ?tag=... and disable Fetch hooks for those patterns.',
		handler: async (c) => {
			const tag = new URL(c.req.url).searchParams.get('tag');
			if (!tag) return c.json({ ok: false, error: 'Missing ?tag=' }, 400);
			const r = await stopBundleCapture(tag);
			return c.json(r);
		},
	},

	// ─── DEBUG: NVIDIA bundle instrumentation ────────────────────────
	// Decorates @hcaptcha/react-hcaptcha's execute() with a logging
	// preamble so we can observe every call NVIDIA's UI makes to the
	// captcha SDK along with its arguments. Combined with /pm/poll this
	// gives the full token round-trip in/out without modifying anything
	// hCaptcha protects.
	{
		method: 'POST',
		path: '/debug/instrument/attach',
		description:
			'Attach the NVIDIA-bundle instrumentation: install __bn_instr() in main world + decorate the react-hcaptcha chunk to log execute() calls. Page must be reloaded after attach for the decorator to apply (CDP Fetch only matches in-flight requests).',
		handler: async (c, browser) => {
			if (instrument?.attached) return c.json({ ok: true, alreadyAttached: true });
			const control = browser.getScriptControl();
			if (!control)
				return c.json({ ok: false, error: 'No CdpScriptControl on browser session' }, 503);
			instrument = new BuildNvidiaInstrument();
			await instrument.attach(control);
			return c.json({
				ok: true,
				hint: 'Reload the page (POST /browser/mcp/evaluate {script:"location.reload()"}), then drive a chat and call GET /debug/instrument/log to drain.',
			});
		},
	},

	{
		method: 'GET',
		path: '/debug/instrument/log',
		description:
			'Drain captured execute() calls + mutation events. Entries cleared on each drain; mutations kept for the lifetime of the instrument attach.',
		handler: async (c) => {
			if (!instrument?.attached)
				return c.json({ ok: false, error: 'Instrument not attached' }, 412);
			const entries = await instrument.drain();
			return c.json({ ok: true, entries, mutations: instrument.mutations.slice() });
		},
	},

	{
		method: 'POST',
		path: '/debug/instrument/detach',
		description:
			'Detach instrumentation and remove the decorator. Subsequent page loads see the original bytes.',
		handler: async (c) => {
			if (!instrument) return c.json({ ok: true, alreadyDetached: true });
			await instrument.detach();
			instrument = null;
			return c.json({ ok: true });
		},
	},

	// ─── DEBUG: Runtime API tap ──────────────────────────────────────
	// Wraps EventTarget addEventListener / removeEventListener, the
	// timer APIs, requestAnimationFrame, fetch, and XHR before any
	// page or iframe script runs. Auto-propagates to OOPIFs (the
	// hCaptcha iframe). Each registration + invocation is logged to a
	// per-frame DOM-channel sink (cross-world readable). Bytes are
	// untouched — the hCaptcha CSP/ECDSA-pinned inline.js still validates.
	// Used by domains/build-nvidia/scripts/observe-human.ts to capture
	// what hCaptcha actually does with human input in a headed browser.
	{
		method: 'POST',
		path: '/debug/runtime-tap/attach',
		description:
			'Install the runtime-API tap (EventTarget/timers/rAF/fetch/XHR shims) on every current and future frame. Reload the page after attach so the script fires before page scripts on the next load.',
		handler: async (c, browser) => {
			if (runtimeTapHandle) return c.json({ ok: true, alreadyAttached: true });
			const control = browser.getScriptControl();
			if (!control)
				return c.json({ ok: false, error: 'No CdpScriptControl on browser session' }, 503);
			runtimeTapHandle = await attachRuntimeTap(control);
			return c.json({
				ok: true,
				hint: 'Reload the page (POST /browser/mcp/evaluate {script:"location.reload()"}), then drive interaction and call GET /debug/runtime-tap/log to drain.',
			});
		},
	},

	{
		method: 'GET',
		path: '/debug/runtime-tap/log',
		description:
			'Drain the runtime-tap buffer for every frame on the page (parent + every OOPIF). Buckets by frame URL. Buffer is cleared in-frame on each drain.',
		handler: async (c, browser) => {
			if (!runtimeTapHandle) return c.json({ ok: false, error: 'Runtime tap not attached' }, 412);
			const page = browser.getPage();
			if (!page) return c.json({ ok: false, error: 'No active page' }, 503);
			const drain = await drainRuntimeTap(page);
			return c.json({ ok: true, ...drain });
		},
	},

	{
		method: 'POST',
		path: '/debug/runtime-tap/detach',
		description:
			'Detach the runtime tap. Already-installed shims in existing frames remain — only future frames see clean APIs. Reload to fully restore.',
		handler: async (c, browser) => {
			if (!runtimeTapHandle) return c.json({ ok: true, alreadyDetached: true });
			const control = browser.getScriptControl();
			if (control) await detachRuntimeTap(control, runtimeTapHandle);
			runtimeTapHandle = null;
			return c.json({ ok: true });
		},
	},

	{
		method: 'GET',
		path: '/debug/runtime-tap/summary',
		description:
			'Drain + compute a quick summary: counts per (api, kind, type, frame). Useful as a sanity check before pulling the full log. Body equivalent to /log but with an extra `summary` field.',
		handler: async (c, browser) => {
			if (!runtimeTapHandle) return c.json({ ok: false, error: 'Runtime tap not attached' }, 412);
			const page = browser.getPage();
			if (!page) return c.json({ ok: false, error: 'No active page' }, 503);
			const drain = await drainRuntimeTap(page);
			const summary = computeRuntimeTapSummary(drain.frames);
			return c.json({ ok: true, ...drain, summary });
		},
	},

	// ─── DEBUG: E1 — capture predict POST + Bun-side replay ─────────
	// Drives a real chat in the browser, records the predict POST as
	// Patchright sees it (URL/headers/body/cookies), then enables a
	// Bun-fetch replay test to determine: is the nv-captcha-token
	// reusable? bound to cookies? bound to TLS fingerprint?
	{
		method: 'POST',
		path: '/debug/capture-predict',
		description:
			'Drive a chat and capture the predict POST (URL, headers, body, cookies) for E1 token-replay testing. Body: {"model":"openai/gpt-oss-20b","message":"hello"}. Persists in memory; subsequent /debug/replay-predict replays the captured tuple.',
		handler: async (c, browser) => {
			const body = await c.req
				.json<{ model?: string; message?: string }>()
				.catch(() => ({}) as { model?: string; message?: string });
			const model = body.model ?? 'openai/gpt-oss-20b';
			const message = body.message ?? `What is 2+2? Answer in one word.`;
			await ensurePersona(browser);
			try {
				const result = await browserDrivenChatCapture(browser, { model, message });
				lastCapturedPredict = result.capture;
				return c.json({
					ok: true,
					chat: { status: result.chat.status, body: result.chat.body },
					capture: {
						url: result.capture.url,
						method: result.capture.method,
						headerCount: Object.keys(result.capture.headers).length,
						headerKeys: Object.keys(result.capture.headers),
						postDataLen: result.capture.postData?.length ?? 0,
						cookieCount: result.capture.cookies.length,
						cookieNames: result.capture.cookies.map((ck) => ck.name),
						pageUrl: result.capture.pageUrl,
						capturedAt: result.capture.capturedAt,
						ageMs: Date.now() - result.capture.capturedAt,
					},
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ ok: false, error: msg }, 502);
			}
		},
	},

	{
		method: 'POST',
		path: '/debug/capture-unburned',
		description:
			'E2/E3: capture a fresh, UN-BURNED predict POST. Drives the captcha mint as normal, but uses page.route to abort the browser\'s outgoing POST before it reaches the server. The captured nv-captcha-token is unused. Body: {"model":"openai/gpt-oss-20b","message":"hello"}.',
		handler: async (c, browser) => {
			const body = await c.req
				.json<{ model?: string; message?: string }>()
				.catch(() => ({}) as { model?: string; message?: string });
			const model = body.model ?? 'openai/gpt-oss-20b';
			const message = body.message ?? `What is 2+2? Answer in one word.`;
			await ensurePersona(browser);
			try {
				const cap = await captureUnburned(browser, { model, message });
				lastCapturedPredict = cap;
				return c.json({
					ok: true,
					capture: {
						url: cap.url,
						method: cap.method,
						headerCount: Object.keys(cap.headers).length,
						headerKeys: Object.keys(cap.headers),
						postDataLen: cap.postData?.length ?? 0,
						cookieCount: cap.cookies.length,
						capturedAt: cap.capturedAt,
					},
					hint: 'Token is fresh. Use POST /debug/replay-predict to test it from Bun.',
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return c.json({ ok: false, error: msg }, 502);
			}
		},
	},

	{
		method: 'GET',
		path: '/debug/last-predict',
		description:
			'Inspect the most recently captured predict POST (from /debug/capture-predict). Returns full headers + body for inspection. The nv-captcha-token is in the headers map.',
		handler: async (c) => {
			if (!lastCapturedPredict) return c.json({ ok: false, error: 'No capture yet' }, 412);
			return c.json({
				ok: true,
				ageMs: Date.now() - lastCapturedPredict.capturedAt,
				capture: lastCapturedPredict,
			});
		},
	},

	{
		method: 'POST',
		path: '/debug/replay-predict',
		description:
			'Replay the most recently captured predict POST from Bun fetch. Body (all optional): {"skipCookies":bool, "headerDenylist":["nv-captcha-token","cookie",...], "headerOverrides":{...}, "body":"...", "timeoutMs":60000}. Returns status, response headers, body, and duration. Never throws — errors land in `error` field.',
		handler: async (c) => {
			if (!lastCapturedPredict) return c.json({ ok: false, error: 'No capture yet' }, 412);
			const opts = await c.req.json<ReplayOptions>().catch(() => ({}) as ReplayOptions);
			const result = await replayPredict(lastCapturedPredict, opts);
			return c.json({
				ok: result.status >= 200 && result.status < 300,
				ageMsAtReplay: Date.now() - lastCapturedPredict.capturedAt,
				...result,
				bodyText:
					result.bodyText.length > 4000
						? `${result.bodyText.slice(0, 4000)}…[${result.bodyText.length} bytes total]`
						: result.bodyText,
			});
		},
	},
];

/**
 * Compute a compact summary table from a runtime-tap drain. One bucket
 * per (frame, api, kind, type) — useful for "did the human keystrokes
 * actually fire any keydown listener inside the hCaptcha frame?" at a
 * glance, without scrolling the raw entries.
 */
function computeRuntimeTapSummary(frames: Record<string, RuntimeTapEntry[]>): Array<{
	frame: string;
	api: string;
	kind: string;
	type: string;
	count: number;
	trustedRatio?: number;
}> {
	const buckets = new Map<
		string,
		{
			frame: string;
			api: string;
			kind: string;
			type: string;
			count: number;
			trusted: number;
			withEvt: number;
		}
	>();
	for (const [frame, entries] of Object.entries(frames)) {
		for (const e of entries) {
			const type = e.type ?? e.evt?.type ?? '';
			const key = `${frame}|${e.api}|${e.kind}|${type}`;
			let b = buckets.get(key);
			if (!b) {
				b = { frame, api: e.api, kind: e.kind, type, count: 0, trusted: 0, withEvt: 0 };
				buckets.set(key, b);
			}
			b.count++;
			if (e.evt) {
				b.withEvt++;
				if (e.evt.isTrusted) b.trusted++;
			}
		}
	}
	const out = Array.from(buckets.values()).map((b) => ({
		frame: b.frame,
		api: b.api,
		kind: b.kind,
		type: b.type,
		count: b.count,
		...(b.withEvt > 0 ? { trustedRatio: +(b.trusted / b.withEvt).toFixed(3) } : {}),
	}));
	out.sort((a, b) => b.count - a.count);
	return out;
}
