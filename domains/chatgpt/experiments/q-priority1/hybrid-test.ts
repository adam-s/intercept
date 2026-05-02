/**
 * Hybrid Priority-1 test:
 *   - Mint fresh per-message tokens via the SDK loaded into the browser's
 *     parent page (NOT inside the sentinel iframe — `SentinelSDK.token()`
 *     refuses to run in iframe context).
 *   - Fire a Bun fetch to `/backend-anon/f/conversation` with those tokens
 *     within ~1 second of mint.
 *   - 200 → tokens are reusable from a non-Chrome client, Priority-1 path
 *     is "browser mints, Bun fetches".
 *   - 403 → wall is at HTTP/2 / TLS protocol layer, headers/tokens are
 *     irrelevant once the connection's fingerprint is wrong.
 *
 * Run: bun domains/chatgpt/experiments/q-priority1/hybrid-test.ts
 */

const API = 'http://localhost:3001';
const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const BUILD_HASH = 'prod-e72ce87e983a564c22178e7872785a3f094cfdff';
const BUILD_NUMBER = '6311184';

async function evaluate<T>(script: string): Promise<T> {
	const r = await fetch(`${API}/browser/mcp/evaluate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ script }),
	});
	const j = (await r.json()) as { result: T };
	return j.result;
}

async function main() {
	console.log('=== STEP 1: confirm browser is on chatgpt.com ===');
	const url = await evaluate<string>('location.href');
	console.log('  url:', url);
	if (!url.startsWith('https://chatgpt.com/')) {
		throw new Error('browser not on chatgpt.com');
	}

	console.log('\n=== STEP 2: load SDK into the parent page if not already ===');
	const sdkLoaded = await evaluate<string>(
		`(async () => {
			if (window.SentinelSDK) return 'already-loaded:' + Object.keys(window.SentinelSDK).join(',');
			const r = await fetch('/sentinel/20260423af3c/sdk.js');
			const text = await r.text();
			(0, eval)(text);
			return window.SentinelSDK
				? 'loaded:' + Object.keys(window.SentinelSDK).join(',')
				: 'failed-no-sdk';
		})()`,
	);
	console.log('  sdk:', sdkLoaded);

	console.log('\n=== STEP 3: probe what `flow` values the browser uses ===');
	// We don't yet know what string the real submit passes. Try a few that
	// match the SDK's internal naming.
	const flows = ['chat-requirements', 'next', 'conversation', 'submit', 'test-key'];
	for (const flow of flows) {
		const tok = await evaluate<string>(
			`(async () => {
				try {
					const t0 = Date.now();
					const r = await window.SentinelSDK.token(${JSON.stringify(flow)});
					return JSON.stringify({ flow: ${JSON.stringify(flow)}, ms: Date.now() - t0, len: String(r).length, head: String(r).slice(0, 80) });
				} catch (e) { return JSON.stringify({ flow: ${JSON.stringify(flow)}, err: e.message }); }
			})()`,
		);
		console.log('  ', tok);
	}

	console.log('\n=== STEP 4: get fresh tokens for a real-looking flow ===');
	const flowName = 'next';
	const tokenStr = await evaluate<string>(`window.SentinelSDK.token(${JSON.stringify(flowName)})`);
	console.log('  token() returned (first 200):', tokenStr.slice(0, 200));
	let tokens: { p?: string; t?: string; c?: string; id?: string; flow?: string };
	try {
		tokens = JSON.parse(tokenStr);
	} catch {
		throw new Error('token() did not return JSON: ' + tokenStr.slice(0, 100));
	}
	console.log('  parsed:', {
		p_len: tokens.p?.length,
		t_len: tokens.t?.length,
		c_len: tokens.c?.length,
		id: tokens.id,
		flow: tokens.flow,
	});

	console.log('\n=== STEP 5: also harvest cookies, oai-session-id from the browser ===');
	const browserState = await evaluate<string>(`JSON.stringify({
		cookies: document.cookie,
		did: (document.cookie.match(/oai-did=([a-f0-9-]+)/) || [])[1],
	})`);
	const { cookies, did } = JSON.parse(browserState) as { cookies: string; did: string };
	console.log('  cookies len:', cookies.length, '  did:', did);

	console.log('\n=== STEP 6: fire Bun fetch to /backend-anon/f/conversation ===');
	const turnTraceId = crypto.randomUUID();
	const partialQueryId = crypto.randomUUID();
	const body = {
		action: 'next',
		messages: [
			{
				id: partialQueryId,
				author: { role: 'user' },
				create_time: Date.now() / 1000,
				content: { content_type: 'text', parts: ['hi from priority-1 hybrid'] },
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

	const headers: Record<string, string> = {
		'user-agent': UA,
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
		'oai-client-version': BUILD_HASH,
		'oai-client-build-number': BUILD_NUMBER,
		'oai-session-id': crypto.randomUUID(),
		'x-openai-target-path': '/backend-api/f/conversation',
		'x-openai-target-route': '/backend-api/f/conversation',
		'oai-echo-logs': '0,42000',
		'oai-telemetry': '[1,null]',
		'x-oai-turn-trace-id': turnTraceId,
		'openai-sentinel-chat-requirements-token': tokens.c ?? '',
		'openai-sentinel-proof-token': tokens.p ?? '',
		'openai-sentinel-turnstile-token': tokens.t ?? '',
	};

	const t0 = Date.now();
	const r = await fetch('https://chatgpt.com/backend-anon/f/conversation', {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
	const elapsed = Date.now() - t0;
	const text = await r.text();
	const cfm = r.headers.get('cf-mitigated');
	const ct = r.headers.get('content-type');
	console.log(
		`  status=${r.status}  elapsed=${elapsed}ms  cf-mitigated=${cfm ?? 'null'}  ct=${ct}  body_len=${text.length}`,
	);
	console.log('  body preview:', text.slice(0, 600));

	if (r.status === 200 && ct?.includes('event-stream')) {
		console.log('\n  🟢🟢🟢 PRIORITY-1 HYBRID WORKS — Bun fetch succeeded with SDK-minted tokens.');
	} else if (r.status === 403) {
		console.log('\n  🔴 403 — wall is at protocol-fingerprint level, NOT token freshness.');
		console.log('  Next step: curl-impersonate-chrome or accept Priority 2.');
	} else {
		console.log(`\n  ⚠ unexpected status ${r.status}`);
	}
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
