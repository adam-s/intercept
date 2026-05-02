/**
 * Bun-only anon-flow client for chatgpt.com (no browser, no Patchright).
 *
 * Cloudflare's TLS fingerprint check is bypassed because Bun uses BoringSSL
 * (the same TLS stack as Chromium). Standard Node fetch / curl get blocked
 * with `cf-mitigated: challenge`; Bun does not.
 *
 * Build details captured from a real session 2026-05-01:
 *   OAI-Client-Version  = prod-e72ce87e983a564c22178e7872785a3f094cfdff
 *   OAI-Client-Build    = 6311184
 *
 * Sequence:
 *   1.  GET /                              → CF cookies, oai-did
 *   2.  GET /backend-anon/me               → confirm session
 *   3.  POST /sentinel/chat-requirements/prepare
 *         body: { p: "gAAAAAC" + base64(JSON_array_payload) }
 *   4.  POST /sentinel/chat-requirements/finalize
 *         body: { prepare_token, proofofwork, turnstile }
 *   5.  POST /f/conversation/prepare
 *         body: full conversation context with `partial_query`
 *   6.  POST /f/conversation
 *         body: full message
 *
 * The `proofofwork` and `turnstile` values come from the SDK's
 * `_generateRequirementsTokenAnswerBlocking`. We don't yet have a port —
 * for now we craft plausible values from observed format and let the server
 * tell us what's wrong.
 */

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const BUILD_HASH = 'prod-e72ce87e983a564c22178e7872785a3f094cfdff';
const BUILD_NUMBER = '6311184';

const jar = new Map<string, string>();
const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
function ingest(setCookies: string[] | null) {
	if (!setCookies) return;
	for (const sc of setCookies) {
		const [pair] = sc.split(';');
		const eq = pair.indexOf('=');
		if (eq >= 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
	}
}

const sessionId = crypto.randomUUID();
const trace = (label: string) => console.log(`\n>>> ${label}`);

interface StepOpts {
	method?: string;
	body?: string | undefined;
	headers?: Record<string, string>;
}
async function step(name: string, url: string, opts: StepOpts = {}) {
	const did = jar.get('oai-did');
	const headers: Record<string, string> = {
		'user-agent': UA,
		'accept-language': 'en-US,en;q=0.9',
		'accept-encoding': 'gzip, deflate, br',
		cookie: cookieHeader(),
		origin: 'https://chatgpt.com',
		referer: 'https://chatgpt.com/',
		'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"macOS"',
		'sec-fetch-mode': 'cors',
		'sec-fetch-dest': 'empty',
		'sec-fetch-site': 'same-origin',
		accept: '*/*',
		'oai-language': 'en-US',
		'oai-client-version': BUILD_HASH,
		'oai-client-build-number': BUILD_NUMBER,
		'oai-session-id': sessionId,
		...(did && { 'oai-device-id': did }),
		...(opts.headers || {}),
	};
	const init: RequestInit = { method: opts.method || 'GET', headers };
	if (opts.body !== undefined) init.body = opts.body;
	const r = await fetch(url, init);
	ingest(r.headers.getSetCookie?.() ?? null);
	const text = await r.text();
	console.log(`[${name.padEnd(22)}] ${r.status}  body=${text.length}  ${text.slice(0, 200)}`);
	return {
		status: r.status,
		body: text,
		headers: r.headers,
		json: () => {
			try {
				return JSON.parse(text);
			} catch {
				return null;
			}
		},
	};
}

// ─── Build the `p` payload (prepare) ──────────────────────────────────────
//
// The trailing 7 zeros in the array are believed to be __oai_so_* behavioural
// counters (keystroke count, mouse distance, scroll count, idle ms, …). A
// real user submitting a message has NON-ZERO values here. The server may
// reject "user submitted but zero keystrokes" as bot-like.
function makePreparePayload(seq = 0): string {
	const arr = [
		1600,
		new Date().toString(),
		4294967296,
		1,
		UA,
		'https://www.googletagmanager.com/gtag/js?id=G-9SHBSK2D9J',
		BUILD_HASH,
		'en-US',
		'en-US',
		0.19999992847442627,
		'createAuctionNonce−function createAuctionNonce() { [native code] }',
		'_reactListeningmprv9gz2w9',
		'toolbar',
		42608.5 + seq * 100,
		crypto.randomUUID(),
		'',
		8,
		Date.now() + 783.4 + seq,
		// Plausible behavioural-signal values (kt_count, mv_dist, mv_vel,
		// sc_count, sc_dist, idle_ms, click_count). Real user typed "hi"
		// over ~3s with some mouse motion.
		2, // keystrokes ('h', 'i')
		3800, // mouse distance px
		3, // scrolls
		1240, // scroll distance px
		1200, // idle ms
		1, // clicks
		0, // padding
	];
	return 'gAAAAAC' + Buffer.from(JSON.stringify(arr)).toString('base64');
}

// ─── Build proofofwork value (for finalize) ───────────────────────────────
// Format: "gAAAAAB" + base64(JSON_array) + "~S"
//   array layout (from observed wire trace):
//     [1600, timestamp, 4294967296, ITERATIONS, UA, gtag_url, build,
//      "en-US", "en-US", PoW_NONCE, "userActivation−[object UserActivation]",
//      reactContainer_key, "onappinstalled", react_render_time,
//      uuid, "", 8, perf_origin, 0, ...]
function makeProofOfWork(): string {
	const arr = [
		1600,
		new Date().toString(),
		4294967296,
		180, // iterations claimed
		UA,
		'https://www.googletagmanager.com/gtag/js?id=G-9SHBSK2D9J',
		BUILD_HASH,
		'en-US',
		'en-US',
		166, // PoW nonce (small int)
		'userActivation−[object UserActivation]',
		'__reactContainer$wz0z5ivbf4',
		'onappinstalled',
		32197.5,
		crypto.randomUUID(),
		'',
		8,
		Date.now() + 0.1,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
	];
	return 'gAAAAAB' + Buffer.from(JSON.stringify(arr)).toString('base64') + '~S';
}

// ─── Build turnstile value (XOR-encoded short blob) ───────────────────────
// Observed: "TgwHBhsdBxYPDHd1dGsXGBcdAxoHGhcOABcDAwwZAAEFGwwGGQwDABseARYPHhkWBh0bBQYMDwAEGQINGx8FBAUeBQQHHQ0ASA=="
// We don't know the XOR key — try a placeholder of similar length.
function makeTurnstile(): string {
	// Placeholder: replay the captured value verbatim, see what the server says.
	return 'TgwHBhsdBxYPDHd1dGsXGBcdAxoHGhcOABcDAwwZAAEFGwwGGQwDABseARYPHhkWBh0bBQYMDwAEGQINGx8FBAUeBQQHHQ0ASA==';
}

// ─── Run the flow ────────────────────────────────────────────────────────
async function main() {
	trace('1. GET /  (cookies + CF state)');
	await step('GET /', 'https://chatgpt.com/', {
		headers: {
			accept:
				'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
			'sec-fetch-mode': 'navigate',
			'sec-fetch-dest': 'document',
			'sec-fetch-site': 'none',
			'sec-fetch-user': '?1',
			'upgrade-insecure-requests': '1',
		},
	});
	console.log('  oai-did=', jar.get('oai-did'));

	trace('2. GET /backend-anon/me');
	await step('GET me', 'https://chatgpt.com/backend-anon/me');

	trace('3. POST /sentinel/chat-requirements/prepare  body={p}');
	const prepR = await step(
		'POST sentinel/prep',
		'https://chatgpt.com/backend-anon/sentinel/chat-requirements/prepare',
		{
			method: 'POST',
			body: JSON.stringify({ p: makePreparePayload() }),
			headers: { 'content-type': 'application/json' },
		},
	);
	const prepJson = prepR.json();
	if (!prepJson?.prepare_token) {
		console.log('FAILED: no prepare_token in response. Aborting.');
		return;
	}
	console.log(`  prepare_token len=${prepJson.prepare_token.length}, persona=${prepJson.persona}`);

	trace(
		'4. POST /sentinel/chat-requirements/finalize  body={prepare_token, proofofwork, turnstile}',
	);
	const finBody = {
		prepare_token: prepJson.prepare_token,
		proofofwork: makeProofOfWork(),
		turnstile: makeTurnstile(),
	};
	const finR = await step(
		'POST sentinel/final',
		'https://chatgpt.com/backend-anon/sentinel/chat-requirements/finalize',
		{
			method: 'POST',
			body: JSON.stringify(finBody),
			headers: { 'content-type': 'application/json' },
		},
	);
	const finJson = finR.json();
	const sentinelToken = finJson?.token;
	if (sentinelToken) console.log(`  finalize token len=${sentinelToken.length}`);

	const turnTraceId = crypto.randomUUID();
	const partialQueryId = crypto.randomUUID();

	trace('5. POST /f/conversation/prepare  body=partial_query');
	const fpBody = {
		action: 'next',
		fork_from_shared_post: false,
		parent_message_id: 'client-created-root',
		model: 'auto',
		client_prepare_state: 'none',
		timezone_offset_min: 240,
		timezone: 'America/New_York',
		conversation_mode: { kind: 'primary_assistant' },
		system_hints: [],
		partial_query: {
			id: partialQueryId,
			author: { role: 'user' },
			content: { content_type: 'text', parts: ['hi from priority-1'] },
		},
		supports_buffering: true,
		supported_encodings: ['v1'],
		client_contextual_info: { app_name: 'chatgpt.com' },
	};
	const fpHeaders: Record<string, string> = {
		'content-type': 'application/json',
		'x-conduit-token': 'no-token',
		'x-oai-turn-trace-id': turnTraceId,
	};
	if (sentinelToken) fpHeaders['openai-sentinel-chat-requirements-token'] = sentinelToken;
	const fpR = await step(
		'POST f/prepare',
		'https://chatgpt.com/backend-anon/f/conversation/prepare',
		{
			method: 'POST',
			body: JSON.stringify(fpBody),
			headers: fpHeaders,
		},
	);
	const fpJson = fpR.json();
	const conduitToken = fpJson?.conduit_token;
	if (conduitToken) console.log(`  conduit_token len=${conduitToken.length}`);

	trace('6. POST /f/conversation  body=message');
	const msgBody = {
		action: 'next',
		messages: [
			{
				id: partialQueryId,
				author: { role: 'user' },
				create_time: Date.now() / 1000,
				content: { content_type: 'text', parts: ['hi from priority-1'] },
				metadata: {
					selected_github_repos: [],
					selected_all_github_repos: false,
					serialization_metadata: { custom_symbol_offsets: [] },
				},
			},
		],
		parent_message_id: 'client-created-root',
		model: 'auto',
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
	const msgHeaders: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'text/event-stream',
		'x-oai-turn-trace-id': turnTraceId,
		// Critical headers observed on the live browser's f/conversation POST
		// (Patchright's CDP trace truncated OAI-Echo-Logs at 4012 chars; we
		// send '0' as a minimal placeholder).
		'x-openai-target-path': '/backend-api/f/conversation',
		'x-openai-target-route': '/backend-api/f/conversation',
		'oai-echo-logs': '0',
	};
	if (conduitToken) msgHeaders['x-conduit-token'] = conduitToken;
	if (sentinelToken) msgHeaders['openai-sentinel-chat-requirements-token'] = sentinelToken;
	await step('POST conversation', 'https://chatgpt.com/backend-anon/f/conversation', {
		method: 'POST',
		body: JSON.stringify(msgBody),
		headers: msgHeaders,
	});
}

main().catch(console.error);
