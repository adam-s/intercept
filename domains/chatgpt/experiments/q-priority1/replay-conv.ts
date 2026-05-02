/**
 * Hypothesis-1 test: replay a captured `OAI-Echo-Logs` verbatim from Bun.
 *
 * Flow:
 *   1. Drive a live browser to chatgpt.com via the local API.
 *   2. TYPE a message (do NOT click send) — typing fires
 *      `/f/conversation/prepare` and emits Echo-Logs etc., without
 *      consuming the Sentinel pass-token slot at `/f/conversation`.
 *   3. Drain the deep logger to find the most recent
 *      `/f/conversation/prepare` Request: pull its full headers
 *      (including the 4 KB Echo-Logs blob).
 *   4. Pull the sentinel pass-token from the latest finalize response
 *      and the conduit_token from the f/conversation/prepare response.
 *   5. Pull document.cookie from the live browser.
 *   6. POST `/f/conversation` from Bun directly, with the *live* Echo-
 *      Logs value, sentinel token, conduit token and cookies. Same
 *      process so timing is tight (~1-3 seconds).
 *   7. If 200 → Hypothesis 1 confirmed; if 403 → escalate.
 *
 * Run:
 *   bun domains/chatgpt/experiments/q-priority1/replay-conv.ts
 */

const API = 'http://localhost:3001';
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const BUILD_HASH = 'prod-e72ce87e983a564c22178e7872785a3f094cfdff';
const BUILD_NUMBER = '6311184';

type LogEntry = {
	seq: number;
	t: number;
	frame: string;
	type: string;
	op: string;
	url?: string;
	method?: string;
	headers?: string;
	body?: string;
	[k: string]: unknown;
};

async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
	const r = await fetch(`${API}${path}`, init);
	if (!r.ok && r.status !== 404) {
		const text = await r.text();
		throw new Error(`${path}: ${r.status} ${text.slice(0, 200)}`);
	}
	return r.json() as Promise<T>;
}

async function evaluateInBrowser<T = unknown>(script: string): Promise<T> {
	const r = await fetch(`${API}/browser/mcp/evaluate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ script }),
	});
	const j = (await r.json()) as { result: T };
	return j.result;
}

async function drainLogs(): Promise<LogEntry[]> {
	const r = await fetch(`${API}/api/chatgpt/experiments/drain-logs`);
	const j = (await r.json()) as { entries: LogEntry[] };
	return j.entries;
}

function dedupe(entries: LogEntry[]): LogEntry[] {
	const seen = new Set<number>();
	const out: LogEntry[] = [];
	for (const e of entries) {
		if (seen.has(e.seq)) continue;
		seen.add(e.seq);
		out.push(e);
	}
	return out;
}

async function main() {
	console.log('=== STEP 0: confirm API is up ===');
	const health = await fetch(`${API}/health`);
	console.log(`  /health → ${health.status}`);
	if (!health.ok) throw new Error('API not running');

	console.log('\n=== STEP 1: install deep logger ===');
	const inst = await api<{ ok: boolean; alreadyInstalled?: boolean }>(
		'/api/chatgpt/experiments/install-deep-logger',
		{ method: 'POST' },
	);
	console.log('  install:', inst);

	console.log('\n=== STEP 2: navigate to chatgpt.com ===');
	await evaluateInBrowser('location.href = "https://chatgpt.com/"; "navigating"');
	console.log('  waiting 16s for hydrate…');
	await new Promise((r) => setTimeout(r, 16000));

	const pageState = await evaluateInBrowser<string>(`JSON.stringify({
		url: location.href,
		hasComposer: !!document.querySelector('#prompt-textarea, [contenteditable=true]'),
		hasButton: !!document.querySelector('button[data-testid="send-button"]')
	})`);
	console.log('  page state:', pageState);

	console.log(
		'\n=== STEP 3: clear logs, then TYPE (no click) to trigger /f/conversation/prepare ===',
	);
	await fetch(`${API}/api/chatgpt/experiments/clear-logs`, { method: 'POST' });
	await fetch(`${API}/browser/traffic/clear`, { method: 'POST' }).catch(() => {});

	const typed = await evaluateInBrowser<string>(`(async () => {
		const t = document.querySelector('#prompt-textarea, [contenteditable=true]');
		if (!t) return 'no-textarea';
		t.focus();
		document.execCommand('insertText', false, 'hi from priority1 replay');
		await new Promise(r => setTimeout(r, 1500));
		// DO NOT click send — that consumes the sentinel slot.
		return 'typed';
	})()`);
	console.log('  type:', typed);

	console.log('\n  waiting 6s for /f/conversation/prepare to fire…');
	await new Promise((r) => setTimeout(r, 6000));

	console.log('\n=== STEP 4: drain logger and extract artefacts ===');
	const entries = dedupe(await drainLogs());
	console.log(`  total log entries: ${entries.length}`);

	// Find the most recent /f/conversation/prepare Request constructor entry
	// (has the FULL headers including Echo-Logs).
	const fpReqs = entries.filter(
		(e) =>
			e.type === 'Request' &&
			e.op === 'construct' &&
			e.url === 'https://chatgpt.com/backend-anon/f/conversation/prepare',
	);
	if (fpReqs.length === 0) {
		console.log('  ✗ no /f/conversation/prepare Request entries — typing did not fire it');
		// Try to fall back to the fetch entry (smaller header window)
		const fetchEntries = entries.filter(
			(e) =>
				e.type === 'fetch' &&
				e.op === 'request' &&
				typeof e.url === 'string' &&
				e.url === 'https://chatgpt.com/backend-anon/f/conversation/prepare',
		);
		console.log(`  fallback fetch entries: ${fetchEntries.length}`);
		if (fetchEntries.length === 0) {
			console.log('  no fallback — abort');
			return;
		}
		fpReqs.push(...fetchEntries);
	}
	const fpReq = fpReqs[fpReqs.length - 1];
	console.log(
		`  using /f/conversation/prepare entry seq=${fpReq.seq} ageMs=${Date.now() - fpReq.t}`,
	);

	// Parse the headers (they're a JSON-stringified object in the log entry).
	let fpHeaders: Record<string, string> = {};
	try {
		const raw = fpReq.headers || '';
		// Strip the trailing "…(LENGTH)" truncation marker if present.
		const cleaned = raw.replace(/…\(\d+\)"?$/, '"').replace(/…\(\d+\)$/, '');
		fpHeaders = JSON.parse(cleaned);
	} catch (e) {
		console.log('  ✗ could not parse headers JSON:', e);
		console.log('  raw:', (fpReq.headers || '').slice(0, 400));
		return;
	}
	console.log(`  headers parsed: ${Object.keys(fpHeaders).length} keys`);

	const echoLogs = fpHeaders['OAI-Echo-Logs'] || fpHeaders['oai-echo-logs'];
	const sessionId =
		fpHeaders['OAI-Session-Id'] || fpHeaders['oai-session-id'] || crypto.randomUUID();
	const turnTraceId =
		fpHeaders['x-oai-turn-trace-id'] || fpHeaders['X-OAI-Turn-Trace-Id'] || crypto.randomUUID();
	console.log(`  OAI-Echo-Logs len: ${echoLogs ? echoLogs.length : 0}`);
	console.log(`  OAI-Session-Id: ${sessionId}`);
	console.log(`  X-OAI-Turn-Trace-Id (from prepare): ${turnTraceId}`);

	// Find the sentinel pass-token from the most recent /finalize response.
	// The deep logger doesn't capture response bodies in detail for fetches,
	// so we'll need to query the page's localStorage / cookie state OR
	// re-execute prepare→finalize ourselves. Simpler: harvest from cookies.
	const browserCookies = await evaluateInBrowser<string>('document.cookie');
	console.log(`  cookies: ${browserCookies.length} chars`);

	// Pull the sentinel pass-token. The page may have stashed it somewhere.
	// Check known places: localStorage, sessionStorage, window globals.
	const tokenProbe = await evaluateInBrowser<string>(`JSON.stringify({
		ls_keys: Object.keys(localStorage).filter(k => /token|sentinel|requirements|chat/i.test(k)),
		ss_keys: Object.keys(sessionStorage).filter(k => /token|sentinel|requirements|chat/i.test(k))
	})`);
	console.log('  token storage keys:', tokenProbe);

	// We can't easily extract the sentinel pass-token from the browser page —
	// it's held in JS module closure. Workaround: fire a fresh prepare→finalize
	// from Bun (we know how to make it 200) and use OUR own pass-token. The
	// goal is to test if Echo-Logs alone unblocks the conversation gate.

	console.log('\n=== STEP 5: mint our own sentinel pass-token (Bun) ===');
	const did = (browserCookies.match(/oai-did=([a-f0-9-]+)/) || [])[1];
	if (!did) throw new Error('no oai-did cookie');

	const baseHeaders: Record<string, string> = {
		'user-agent': UA,
		cookie: browserCookies,
		'oai-device-id': did,
		'oai-language': 'en-US',
		'oai-client-version': BUILD_HASH,
		'oai-client-build-number': BUILD_NUMBER,
		'oai-session-id': sessionId,
		origin: 'https://chatgpt.com',
		referer: 'https://chatgpt.com/',
		'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"macOS"',
		'sec-fetch-mode': 'cors',
		'sec-fetch-dest': 'empty',
		'sec-fetch-site': 'same-origin',
		accept: '*/*',
		'accept-language': 'en-US,en;q=0.9',
	};

	// prepare
	const pArr = [
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
		42608.5,
		crypto.randomUUID(),
		'',
		8,
		Date.now() + 0.4,
		2,
		3800,
		3,
		1240,
		1200,
		1,
		0,
	];
	const prepareBody = { p: 'gAAAAAC' + Buffer.from(JSON.stringify(pArr)).toString('base64') };
	const prepR = await fetch('https://chatgpt.com/backend-anon/sentinel/chat-requirements/prepare', {
		method: 'POST',
		headers: { ...baseHeaders, 'content-type': 'application/json' },
		body: JSON.stringify(prepareBody),
	});
	const prepJson = (await prepR.json()) as { prepare_token?: string };
	console.log(
		`  prepare → ${prepR.status}, prepare_token len=${prepJson.prepare_token?.length ?? 0}`,
	);
	if (!prepJson.prepare_token) {
		console.log('  ✗ prepare failed; abort');
		return;
	}

	// finalize
	const powArr = [
		1600,
		new Date().toString(),
		4294967296,
		180,
		UA,
		'https://www.googletagmanager.com/gtag/js?id=G-9SHBSK2D9J',
		BUILD_HASH,
		'en-US',
		'en-US',
		166,
		'userActivation−[object UserActivation]',
		'__reactContainer$wz0z5ivbf4',
		'onappinstalled',
		32197.5,
		crypto.randomUUID(),
		'',
		8,
		Date.now() + 0.1,
		2,
		3800,
		3,
		1240,
		1200,
		1,
		0,
	];
	const finBody = {
		prepare_token: prepJson.prepare_token,
		proofofwork: 'gAAAAAB' + Buffer.from(JSON.stringify(powArr)).toString('base64') + '~S',
		turnstile:
			'TgwHBhsdBxYPDHd1dGsXGBcdAxoHGhcOABcDAwwZAAEFGwwGGQwDABseARYPHhkWBh0bBQYMDwAEGQINGx8FBAUeBQQHHQ0ASA==',
	};
	const finR = await fetch('https://chatgpt.com/backend-anon/sentinel/chat-requirements/finalize', {
		method: 'POST',
		headers: { ...baseHeaders, 'content-type': 'application/json' },
		body: JSON.stringify(finBody),
	});
	const finJson = (await finR.json()) as { token?: string };
	console.log(`  finalize → ${finR.status}, token len=${finJson.token?.length ?? 0}`);
	if (!finJson.token) {
		console.log('  ✗ finalize failed; abort');
		return;
	}

	// f/conversation/prepare with our own session id (same as headers above)
	const ourTurnTraceId = crypto.randomUUID();
	const ourPartialQueryId = crypto.randomUUID();
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
			id: ourPartialQueryId,
			author: { role: 'user' },
			content: { content_type: 'text', parts: ['hi from priority-1 replay'] },
		},
		supports_buffering: true,
		supported_encodings: ['v1'],
		client_contextual_info: { app_name: 'chatgpt.com' },
	};
	const fpR2 = await fetch('https://chatgpt.com/backend-anon/f/conversation/prepare', {
		method: 'POST',
		headers: {
			...baseHeaders,
			'content-type': 'application/json',
			'x-conduit-token': 'no-token',
			'x-oai-turn-trace-id': ourTurnTraceId,
			'openai-sentinel-chat-requirements-token': finJson.token,
		},
		body: JSON.stringify(fpBody),
	});
	const fpJson2 = (await fpR2.json()) as { conduit_token?: string };
	console.log(
		`  f/prepare → ${fpR2.status}, conduit_token len=${fpJson2.conduit_token?.length ?? 0}`,
	);

	console.log('\n=== STEP 6: POST /f/conversation with VERBATIM live Echo-Logs ===');
	const msgBody = {
		action: 'next',
		messages: [
			{
				id: ourPartialQueryId,
				author: { role: 'user' },
				create_time: Date.now() / 1000,
				content: { content_type: 'text', parts: ['hi from priority-1 replay'] },
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

	const variants: Array<[string, Record<string, string>]> = [
		[
			'with-live-echo-logs',
			{
				...baseHeaders,
				'content-type': 'application/json',
				accept: 'text/event-stream',
				'x-oai-turn-trace-id': ourTurnTraceId,
				'x-openai-target-path': '/backend-api/f/conversation',
				'x-openai-target-route': '/backend-api/f/conversation',
				'openai-sentinel-chat-requirements-token': finJson.token,
				'x-conduit-token': fpJson2.conduit_token || 'no-token',
				...(echoLogs ? { 'oai-echo-logs': echoLogs } : {}),
			},
		],
		[
			'no-echo-logs (control)',
			{
				...baseHeaders,
				'content-type': 'application/json',
				accept: 'text/event-stream',
				'x-oai-turn-trace-id': crypto.randomUUID(),
				'x-openai-target-path': '/backend-api/f/conversation',
				'x-openai-target-route': '/backend-api/f/conversation',
				'openai-sentinel-chat-requirements-token': finJson.token,
				'x-conduit-token': fpJson2.conduit_token || 'no-token',
			},
		],
	];

	for (const [name, h] of variants) {
		const r = await fetch('https://chatgpt.com/backend-anon/f/conversation', {
			method: 'POST',
			headers: h,
			body: JSON.stringify(msgBody),
		});
		const ct = r.headers.get('content-type') || '';
		const cfm = r.headers.get('cf-mitigated');
		// If 200 SSE — read first chunks
		if (r.status === 200 && ct.includes('event-stream')) {
			console.log(`  [${name}] 🟢 ${r.status} ct=${ct} cfm=${cfm}`);
			const text = await r.text();
			console.log(`  body[${text.length}] head: ${text.slice(0, 600)}`);
			console.log(`  → BREAKTHROUGH: pure-Bun anon flow works.`);
		} else {
			const text = await r.text();
			console.log(`  [${name}] ${r.status} ct=${ct} cfm=${cfm}  body: ${text.slice(0, 200)}`);
		}
	}
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
