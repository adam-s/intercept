/**
 * build-nvidia Lambda smoke handler.
 *
 * Receives a captured NVIDIA predict POST tuple (from
 * `/api/build-nvidia/debug/capture-unburned` → `/debug/last-predict`) and
 * replays it from this Lambda's egress IP. Mirrors the chatgpt-toolkit
 * `poc-cookies-bypass` Lambda (experiments/poc-lambda-fanout/lambda/index.mjs)
 * but for NVIDIA's `/v2/predict/models/...` endpoint instead of chatgpt's
 * `/backend-anon/f/conversation`.
 *
 * Goal: confirm whether NVIDIA's predict endpoint is per-IP rate-limited.
 * If a token+cookie tuple minted on the home IP is accepted from a Lambda
 * IP, IP-rotation defeats whatever per-IP cap exists. If it's rejected,
 * NVIDIA pins requests to the minting IP (TLS fingerprint, etc.) and the
 * fan-out path doesn't help.
 *
 * Input event: a `CapturedPredictPost` shape:
 *   { url, method, headers, postData, cookies, pageUrl, capturedAt }
 *   (cookies is array of {name,value,domain,path}; we collapse to header)
 * Returns:
 *   { sourceIP, status, durationMs, bodyExcerpt, headersExcerpt }
 */

const COOKIE_TARGET_HOST = 'api.ngc.nvidia.com';

function buildCookieHeader(cookies, targetHost) {
	if (!Array.isArray(cookies)) return '';
	const matching = cookies.filter((c) => {
		if (!c.domain) return false;
		const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
		return targetHost === d || targetHost.endsWith('.' + d);
	});
	return matching.map((c) => `${c.name}=${c.value}`).join('; ');
}

export const handler = async (event) => {
	let sourceIP = 'unknown';
	try {
		const ipResp = await fetch('https://api.ipify.org?format=json');
		const ipJson = await ipResp.json();
		sourceIP = ipJson.ip ?? 'unknown';
	} catch {}

	const { url, method, headers: capHeaders, postData, cookies } = event;
	if (!url || !method) {
		return { error: 'missing url or method', sourceIP };
	}

	// Forward all captured headers AS-IS (the captured tuple already includes
	// nv-captcha-token, nv-function-id, content-type, accept, etc.). Build
	// a cookie header from the cookie array if not already present.
	const headers = { ...(capHeaders ?? {}) };
	if (!headers.cookie && !headers.Cookie) {
		const ck = buildCookieHeader(cookies, COOKIE_TARGET_HOST);
		if (ck) headers.cookie = ck;
	}

	const t0 = Date.now();
	let status = 0;
	let bodyExcerpt = '';
	const respHeadersExcerpt = {};
	let err = null;
	try {
		const r = await fetch(url, {
			method,
			headers,
			body: postData ?? undefined,
			redirect: 'manual',
		});
		status = r.status;
		const txt = await r.text();
		bodyExcerpt = txt.slice(0, 400);
		const interesting = [
			'content-type',
			'x-amzn-trace-id',
			'cf-ray',
			'server',
			'x-request-id',
			'date',
		];
		for (const k of interesting) {
			const v = r.headers.get(k);
			if (v) respHeadersExcerpt[k] = v;
		}
	} catch (e) {
		err = e?.message || String(e);
	}
	const durationMs = Date.now() - t0;

	return {
		sourceIP,
		status,
		durationMs,
		bodyExcerpt,
		headersExcerpt: respHeadersExcerpt,
		error: err,
	};
};
