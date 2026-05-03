/**
 * hCaptcha frame probing — Phase 2 of docs/HCAPTCHA-VS-TURNSTILE.md.
 *
 * Hypothesis (under investigation):
 *   Patchright's `page.frames()` exposes the cross-origin
 *   `newassets.hcaptcha.com` iframes as OOPIF targets, and
 *   `frame.evaluate(...)` runs in their main world. Initial probe
 *   confirmed reachability — frames are listed and code runs — BUT
 *   `window.hcaptcha` is NOT a global in either of NVIDIA's two
 *   hCaptcha frames. So direct `hcaptcha.execute()` is not the path.
 *
 * What we instead do here:
 *   probeAllHCaptchaFrames  — list all hcaptcha frames and dump every
 *                             top-level window key + interesting symbols
 *                             so we can see what the SDK actually exposes
 *                             internally (function names, object refs).
 *   mintTokenFromFrame      — kept as a best-effort attempt: tries
 *                             `hcaptcha.execute` if present, falls back
 *                             to dispatching click on any visible
 *                             "I'm-not-a-robot" affordance, returns
 *                             whatever surfaces.
 *   postMessageProbe        — installs a postMessage listener on the
 *                             parent and reports the next N messages
 *                             from hCaptcha. This is how the parent
 *                             talks to the iframe; observing the
 *                             protocol is the realistic path forward.
 */

import type { RemoteBrowserService } from '@interceptor/browser/remote';
import type { Frame, Page } from 'patchright';

const HCAPTCHA_HOST = 'newassets.hcaptcha.com';

/** NVIDIA's hCaptcha sitekey, observed in the iframe URL on every model page. */
export const NVIDIA_SITEKEY = '0c6a1e45-75d7-43cc-b836-a0c9d886b8ee';

function findHCaptchaFrames(page: Page): Frame[] {
	return page.frames().filter((f) => f.url().includes(HCAPTCHA_HOST));
}

export interface FrameProbe {
	url: string;
	role: 'CHECKBOX' | 'CHALLENGE' | 'OTHER';
	hasHcaptcha: string;
	captchaKeys: string[];
	allKeys: string[];
	error?: string;
}

export interface ProbeResult {
	allFrames: Array<{ url: string; name: string }>;
	hcapFrames: FrameProbe[];
}

export async function probeHCaptchaFrame(browser: RemoteBrowserService): Promise<ProbeResult> {
	const page = browser.getPage();
	if (!page) throw new Error('No browser page connected');

	const allFrames = page.frames().map((f) => ({ url: f.url(), name: f.name() }));
	const hcapFrames: FrameProbe[] = [];
	for (const frame of findHCaptchaFrames(page)) {
		const url = frame.url();
		const role: FrameProbe['role'] = url.includes('checkbox-invisible')
			? 'CHECKBOX'
			: url.includes('challenge')
				? 'CHALLENGE'
				: 'OTHER';

		const probe = (await frame
			.evaluate(`(() => {
				const w = window;
				const keys = Object.keys(w);
				const captchaKeys = keys.filter(k => /captcha|hcap|solver|widget|exec|token/i.test(k));
				return {
					hasHcaptcha: typeof w.hcaptcha,
					allKeys: keys.slice(0, 200),
					captchaKeys,
				};
			})()`)
			.catch((err: unknown) => ({
				error: err instanceof Error ? err.message : String(err),
			}))) as Partial<FrameProbe>;

		hcapFrames.push({
			url,
			role,
			hasHcaptcha: probe.hasHcaptcha ?? 'eval-failed',
			captchaKeys: probe.captchaKeys ?? [],
			allKeys: probe.allKeys ?? [],
			error: probe.error,
		});
	}

	return { allFrames, hcapFrames };
}

export interface MintResult {
	ok: boolean;
	token?: string;
	tokenLength?: number;
	tokenPrefix?: string;
	durationMs?: number;
	error?: string;
	raw?: unknown;
}

/**
 * E7-D — call window.hsw(jwt, opts) directly inside the challenge iframe.
 * Captures the proof STRING; combined with attached wasm-import-tap, gives
 * us a complete (imports → proof) recording for replay in Node.
 */
export async function hswCallInFrame(
	browser: RemoteBrowserService,
	jwt: string,
	opts: Record<string, unknown>,
	timeoutMs = 30_000,
): Promise<{
	ok: boolean;
	proof?: string;
	proofLen?: number;
	durationMs?: number;
	error?: string;
	frameUrl?: string;
	hasHsw?: boolean;
}> {
	const page = browser.getPage();
	if (!page) return { ok: false, error: 'No browser page connected' };
	const challengeFrames = findHCaptchaFrames(page).filter((f) =>
		f.url().includes('frame=challenge'),
	);
	if (challengeFrames.length === 0)
		return { ok: false, error: 'No challenge iframe found' };
	const frame = challengeFrames[0]!;
	// frame.evaluate runs in ISOLATED world; window.hsw lives in MAIN world.
	// Bridge via CustomEvent on document: detail crosses worlds via
	// structured cloning. Main-world listener is installed by the
	// wasm-import-tap init script.
	const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
	const code = `(async () => {
		const ID = ${JSON.stringify(id)};
		const JWT = ${JSON.stringify(jwt)};
		const OPTS = ${JSON.stringify(opts)};
		const TIMEOUT_MS = ${timeoutMs};
		const result = await new Promise((resolve) => {
			const handler = (ev) => {
				if (!ev || !ev.detail || ev.detail.id !== ID) return;
				document.removeEventListener('__bn_hsw_resp', handler, false);
				resolve(ev.detail);
			};
			document.addEventListener('__bn_hsw_resp', handler, false);
			setTimeout(() => { document.removeEventListener('__bn_hsw_resp', handler, false); resolve({ ok: false, error: 'bridge-timeout' }); }, TIMEOUT_MS);
			document.dispatchEvent(new CustomEvent('__bn_hsw_call', { detail: { id: ID, jwt: JWT, opts: OPTS } }));
		});
		return result;
	})()`;
	const r = (await frame.evaluate(code).catch((err: unknown) => ({
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}))) as { ok: boolean; proof?: string; proofLen?: number; durationMs?: number; error?: string; hasHsw?: boolean };
	return { ...r, frameUrl: frame.url() };
}

/**
 * E7-D — Drive a FULL mint inside the challenge iframe and POST to
 * /getcaptcha. Caller supplies pre-encoded msgpack payload bytes (since the
 * iframe doesn't have a msgpack lib). Returns server response (status, body).
 *
 * Use to isolate which step of the mint pipeline breaks. If this returns
 * status 200 from inside Chrome, every step is fine — only Node's mint
 * differs.
 */
export async function iframeFullMint(
	browser: RemoteBrowserService,
	args: {
		sitekey: string;
		host: string;
		version: string;
		href: string;
		packedPayload: Uint8Array;
		specStr: string;
	},
	timeoutMs = 60_000,
): Promise<{
	ok: boolean;
	status?: number;
	contentType?: string;
	bodyLen?: number;
	bodyText?: string;
	bodyB64?: string;
	error?: string;
}> {
	const page = browser.getPage();
	if (!page) return { ok: false, error: 'No browser page connected' };
	const challengeFrames = findHCaptchaFrames(page).filter((f) => f.url().includes('frame=challenge'));
	if (challengeFrames.length === 0) return { ok: false, error: 'No challenge iframe found' };
	const frame = challengeFrames[0]!;
	const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

	const code = `(async () => {
		const ID = ${JSON.stringify(id)};
		const SITEKEY = ${JSON.stringify(args.sitekey)};
		const SPEC_STR = ${JSON.stringify(args.specStr)};
		const PAYLOAD_B64 = ${JSON.stringify(Buffer.from(args.packedPayload).toString('base64'))};
		const TIMEOUT_MS = ${timeoutMs};
		const packed = Uint8Array.from(atob(PAYLOAD_B64), (c) => c.charCodeAt(0));
		const result = await new Promise((resolve) => {
			const handler = (ev) => {
				if (!ev || !ev.detail || ev.detail.id !== ID) return;
				document.removeEventListener('__bn_iframe_post_resp', handler, false);
				resolve(ev.detail);
			};
			document.addEventListener('__bn_iframe_post_resp', handler, false);
			setTimeout(() => { document.removeEventListener('__bn_iframe_post_resp', handler, false); resolve({ ok: false, error: 'bridge-timeout' }); }, TIMEOUT_MS);
			document.dispatchEvent(new CustomEvent('__bn_iframe_post', { detail: { id: ID, sitekey: SITEKEY, packedPayload: packed, specStr: SPEC_STR } }));
		});
		return result;
	})()`;
	const r = (await frame.evaluate(code).catch((err: unknown) => ({
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}))) as Awaited<ReturnType<typeof iframeFullMint>>;
	return r;
}

/** Encrypt-only inside iframe — caller submits. Used for isolation tests. */
export async function iframeEncrypt(
	browser: RemoteBrowserService,
	packedPayload: Uint8Array,
	timeoutMs = 30_000,
): Promise<{ ok: boolean; encB64?: string; encLen?: number; error?: string }> {
	const page = browser.getPage();
	if (!page) return { ok: false, error: 'No browser page connected' };
	const challengeFrames = findHCaptchaFrames(page).filter((f) => f.url().includes('frame=challenge'));
	if (challengeFrames.length === 0) return { ok: false, error: 'No challenge iframe found' };
	const frame = challengeFrames[0]!;
	const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
	const code = `(async () => {
		const ID = ${JSON.stringify(id)};
		const PAYLOAD_B64 = ${JSON.stringify(Buffer.from(packedPayload).toString('base64'))};
		const TIMEOUT_MS = ${timeoutMs};
		const packed = Uint8Array.from(atob(PAYLOAD_B64), (c) => c.charCodeAt(0));
		const result = await new Promise((resolve) => {
			const handler = (ev) => {
				if (!ev || !ev.detail || ev.detail.id !== ID) return;
				document.removeEventListener('__bn_iframe_encrypt_resp', handler, false);
				resolve(ev.detail);
			};
			document.addEventListener('__bn_iframe_encrypt_resp', handler, false);
			setTimeout(() => { document.removeEventListener('__bn_iframe_encrypt_resp', handler, false); resolve({ ok: false, error: 'bridge-timeout' }); }, TIMEOUT_MS);
			document.dispatchEvent(new CustomEvent('__bn_iframe_encrypt', { detail: { id: ID, packedPayload: packed } }));
		});
		return result;
	})()`;
	const r = (await frame.evaluate(code).catch((err: unknown) => ({
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}))) as { ok: boolean; encB64?: string; encLen?: number; error?: string };
	return r;
}

/** Best-effort mint via direct SDK call — kept as a fallback / sanity check. */
export async function mintTokenFromFrame(
	browser: RemoteBrowserService,
	sitekey: string = NVIDIA_SITEKEY,
	timeoutMs = 30_000,
): Promise<MintResult> {
	const page = browser.getPage();
	if (!page) throw new Error('No browser page connected');
	const frames = findHCaptchaFrames(page);
	if (frames.length === 0) return { ok: false, error: `No frame matching *${HCAPTCHA_HOST}*` };

	const code = `(async (sk, timeoutMs) => {
		if (typeof window.hcaptcha === 'undefined') {
			return { ok: false, error: 'window.hcaptcha undefined inside this frame' };
		}
		const t0 = performance.now();
		try {
			const racePromise = (async () => {
				if (typeof window.hcaptcha.execute === 'function') {
					return await window.hcaptcha.execute(sk, { async: true });
				}
				if (typeof window.hcaptcha.getResponse === 'function') {
					return window.hcaptcha.getResponse();
				}
				throw new Error('Neither hcaptcha.execute nor hcaptcha.getResponse exists');
			})();
			const timer = new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), timeoutMs));
			const raw = await Promise.race([racePromise, timer]);
			const tok = typeof raw === 'string' ? raw : raw && raw.response ? raw.response : null;
			return tok
				? { ok: true, token: tok, tokenLength: tok.length, tokenPrefix: tok.slice(0, 4),
				    durationMs: Math.round(performance.now() - t0), raw }
				: { ok: false, error: 'No token in response', raw, durationMs: Math.round(performance.now() - t0) };
		} catch (e) {
			return { ok: false, error: String(e && e.message || e), durationMs: Math.round(performance.now() - t0) };
		}
	})(${JSON.stringify(sitekey)}, ${timeoutMs})`;

	for (const frame of frames) {
		const r = (await frame.evaluate(code).catch((err: unknown) => ({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		}))) as MintResult;
		if (r.ok) return r;
	}
	return { ok: false, error: 'No frame had a callable hcaptcha SDK' };
}

export interface PostMessageEvent {
	origin: string;
	dataPreview: string;
	dataKeys: string[];
	timestamp: number;
}

/**
 * Install a postMessage listener on the PARENT and report the next N
 * messages received from any hCaptcha origin within `windowMs`.
 * Returns immediately with a poll handle; the caller hits `/poll` to
 * collect captured events.
 *
 * This is the realistic path: NVIDIA's bundle and the hCaptcha iframe
 * communicate via window.postMessage. Capturing the protocol tells us
 * exactly how the React Send handler obtains the token without us
 * having to call the SDK ourselves.
 */
export async function captureHCaptchaPostMessages(
	browser: RemoteBrowserService,
	windowMs = 30_000,
): Promise<{ ok: boolean; tag?: string; error?: string }> {
	const page = browser.getPage();
	if (!page) return { ok: false, error: 'No browser page connected' };
	const tag = `__hcap_pm_${Date.now()}`;
	await page.evaluate(`(() => {
		const TAG = ${JSON.stringify(tag)};
		if (window[TAG]) return;
		const buf = [];
		window[TAG] = buf;
		const handler = (ev) => {
			if (typeof ev.origin !== 'string') return;
			if (!/hcaptcha\\.com/.test(ev.origin)) return;
			let preview, keys = [];
			try {
				if (typeof ev.data === 'string') {
					preview = ev.data.slice(0, 400);
					try { keys = Object.keys(JSON.parse(ev.data)); } catch {}
				} else if (ev.data && typeof ev.data === 'object') {
					keys = Object.keys(ev.data);
					preview = JSON.stringify(ev.data).slice(0, 400);
				}
			} catch (e) { preview = '<unstringifiable>'; }
			buf.push({ origin: ev.origin, dataPreview: preview, dataKeys: keys, timestamp: Date.now() });
			if (buf.length > 200) buf.shift();
		};
		window.addEventListener('message', handler, false);
		setTimeout(() => window.removeEventListener('message', handler, false), ${windowMs});
	})()`);
	return { ok: true, tag };
}

export async function pollHCaptchaPostMessages(
	browser: RemoteBrowserService,
	tag: string,
): Promise<{ ok: boolean; events?: PostMessageEvent[]; error?: string }> {
	const page = browser.getPage();
	if (!page) return { ok: false, error: 'No browser page connected' };
	const events = (await page.evaluate(`(window[${JSON.stringify(tag)}] || []).slice()`)) as
		| PostMessageEvent[]
		| undefined;
	return { ok: true, events: events ?? [] };
}
