/**
 * Bun-side replay of a captured NVIDIA predict POST.
 *
 * Used by the E1 experiments to test whether a `nv-captcha-token` minted
 * inside the browser is reusable from a fresh Bun fetch — without driving
 * any UI. If true (any reuse window, even within the 120s TTL), it changes
 * the cost model dramatically.
 *
 * The captured tuple comes from `browserDrivenChatCapture` in
 * domains/build-nvidia/src/browser-chat.ts.
 */

import type { CapturedPredictPost } from './browser-chat';

export interface ReplayOptions {
	/** Header allowlist — only these are forwarded. Empty = forward all from capture. */
	headerAllowlist?: string[];
	/** Headers to drop entirely. */
	headerDenylist?: string[];
	/** Override headers (after allow/deny is applied). */
	headerOverrides?: Record<string, string>;
	/** Skip cookies entirely (test if they are load-bearing). */
	skipCookies?: boolean;
	/** Override the body. */
	body?: string;
	/** Per-request timeout in ms (default 60s). */
	timeoutMs?: number;
}

export interface ReplayResult {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	bodyText: string;
	durationMs: number;
	error?: string;
}

/**
 * Build cookie header from captured cookie array, scoped to the target host.
 * NVIDIA uses cookies on `.nvidia.com` and `api.ngc.nvidia.com`; harvest both.
 */
function buildCookieHeader(cookies: CapturedPredictPost['cookies'], targetUrl: string): string {
	const u = new URL(targetUrl);
	const host = u.hostname;
	const matching = cookies.filter((c) => {
		if (!c.domain) return false;
		const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
		return host === d || host.endsWith('.' + d);
	});
	return matching.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Replay a captured predict POST from Bun fetch. Returns status + headers
 * + body text + duration. Never throws — errors land in `error`.
 */
export async function replayPredict(
	captured: CapturedPredictPost,
	opts: ReplayOptions = {},
): Promise<ReplayResult> {
	const start = Date.now();
	let headers: Record<string, string> = { ...captured.headers };

	// Header filtering
	if (opts.headerAllowlist && opts.headerAllowlist.length > 0) {
		const allow = new Set(opts.headerAllowlist.map((h) => h.toLowerCase()));
		headers = Object.fromEntries(
			Object.entries(headers).filter(([k]) => allow.has(k.toLowerCase())),
		);
	}
	if (opts.headerDenylist && opts.headerDenylist.length > 0) {
		const deny = new Set(opts.headerDenylist.map((h) => h.toLowerCase()));
		headers = Object.fromEntries(
			Object.entries(headers).filter(([k]) => !deny.has(k.toLowerCase())),
		);
	}
	if (opts.headerOverrides) {
		for (const [k, v] of Object.entries(opts.headerOverrides)) headers[k] = v;
	}

	// Cookies — replay either the captured cookie header OR build from cookie array.
	if (opts.skipCookies) {
		delete headers.cookie;
		delete headers.Cookie;
	} else if (!headers.cookie && !headers.Cookie && captured.cookies.length > 0) {
		const ck = buildCookieHeader(captured.cookies, captured.url);
		if (ck) headers.cookie = ck;
	}

	const body = opts.body ?? captured.postData ?? undefined;

	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);

	try {
		const res = await fetch(captured.url, {
			method: captured.method,
			headers,
			body,
			signal: ctrl.signal,
			// Avoid Node redirecting to a captive portal etc.
			redirect: 'manual',
		});
		const responseHeaders: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			responseHeaders[k] = v;
		});
		// Read the body fully — for SSE this means the stream completes.
		const bodyText = await res.text();
		return {
			status: res.status,
			statusText: res.statusText,
			headers: responseHeaders,
			bodyText,
			durationMs: Date.now() - start,
		};
	} catch (err) {
		return {
			status: 0,
			statusText: '',
			headers: {},
			bodyText: '',
			durationMs: Date.now() - start,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		clearTimeout(timer);
	}
}
