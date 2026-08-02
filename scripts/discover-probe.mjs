#!/usr/bin/env node
/**
 * discover-probe — the mechanical half of the discovery protocol.
 *
 * PURPOSE
 *   The SCAN and GATHER steps used to be a page of literal curl invocations
 *   pasted into an instruction file. Prose does not fail a build: a stale port,
 *   a renamed endpoint, or a jq expression that silently returns nothing all
 *   read as "the site has no API." This script runs those steps instead, so a
 *   broken probe reports a failure rather than an absence.
 *
 *   The judgment stays with the agent. This tool gathers evidence and prints
 *   it; it classifies nothing and decides nothing. Filling the transport
 *   elimination table is still the agent's job, and still the gate before any
 *   route code.
 *
 * MODES
 *   --mode=scan        Traffic summary: method, URL, content type, status, and
 *                      which entries carry pagination parameters.
 *   --mode=paginate    Snapshot traffic, trigger the page's own pagination
 *                      control, snapshot again, and print what the click
 *                      produced. This is the snapshot→trigger→diff loop.
 *   --mode=probe       Call one URL through the browser's fetch, so it carries
 *                      the session. --url is required.
 *   --mode=graphql     One introspection call listing every root query.
 *                      --url defaults to the site's /graphql.
 *   --mode=bundles     Fetch the page's largest scripts and report which
 *                      real-time transports they reference.
 *   --mode=coverage    Diff the call shapes the browser actually made against the
 *                      routes built, and print a recall floor. Reads the
 *                      manifest without draining it.
 *
 *                      Needs registered routes AND captured traffic, and a
 *                      server restart supplies the first while destroying the
 *                      second. So: restart to register the domain, reconnect
 *                      the browser, re-navigate the page types used during
 *                      GATHER, then run this. Against leftover traffic it
 *                      scores routes against the checker's own calls.
 *   --mode=manifest    Install the egress instrument if needed, drain what the
 *                      page's own JS reached for, reduce it to one row per call
 *                      shape, and print the elimination table derived from it.
 *                      This is the instrumented pass — see the two-pass rule in
 *                      .agents/rules/discovery.md before running it against a
 *                      session you intend to keep.
 *   --mode=uninstall   Remove the instrument, handing the page back unmodified.
 *                      Run before any collection pass.
 *
 * FLAGS FOR manifest
 *   --no-sweep         Skip the interaction sweep. The sweep is ON by default,
 *                      because the mode's output is a present/absent verdict
 *                      table and a verdict taken from a page nobody touched is
 *                      not a verdict: every transport that opens behind an
 *                      interaction reads absent, which is indistinguishable
 *                      from the site not having one. It used to be opt-in with
 *                      a printed warning, and a warning is not a gate — the
 *                      table looked finished either way, and the flag was the
 *                      easiest thing in the run to leave off.
 *
 *                      Skip it when suppressing aids one at a time to find what
 *                      a hardened site reacted to. Synthetic interaction has no
 *                      human trajectory and is the loudest aid here, so it is
 *                      the first one to drop — and the output says which way it
 *                      ran, so a quiet table is never mistaken for a clean one.
 *
 * USAGE
 *   node scripts/discover-probe.mjs --mode=scan
 *   node scripts/discover-probe.mjs --mode=paginate
 *   node scripts/discover-probe.mjs --mode=probe --url=/api/items?page=2
 *   node scripts/discover-probe.mjs --mode=graphql --url=/api/graphql
 *   node scripts/discover-probe.mjs --mode=bundles --budget=3
 *   node scripts/discover-probe.mjs --mode=manifest
 *   node scripts/discover-probe.mjs --mode=uninstall
 *   node scripts/discover-probe.mjs --mode=scan --json    # machine-readable
 *
 * PRECONDITION
 *   A browser must already be connected over the WebSocket, because only
 *   WS-connected browsers capture traffic. Connect it first — see
 *   docs/ARCHITECTURE.md. Every mode reports a clear failure when the API
 *   server or the browser is absent, rather than printing an empty result that
 *   reads like "nothing found."
 *
 * BOUNDS
 *   One request per probe. --budget caps how many scripts `bundles` fetches
 *   (default 3) and how many entries `scan` prints (default 60). --timeout ms
 *   per request (default 20000). --settle ms waited after a pagination trigger
 *   (default 5000). No retries: an unexpected response is the finding. Writes
 *   nothing to disk and makes no model calls.
 *
 * Importing this module runs nothing — the pure analysis helpers are exported
 * so scripts/__tests__/discover-probe.test.mjs drives them over fixtures with
 * no network.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Arg parsing ─────────────────────────────────────────────────────

/** The uniform 4-line argv parser every script in this folder shares. */
export function parseArgs(argv) {
	const flags = {};
	for (const arg of argv) {
		const raw = arg.replace(/^--/, '');
		// Split on the FIRST '=' only: a value can contain more of them
		// (--url=/api?page=2), and splitting on all of them silently truncates it.
		const eq = raw.indexOf('=');
		if (eq === -1) flags[raw] = true;
		else flags[raw.slice(0, eq)] = raw.slice(eq + 1);
	}
	return {
		mode: typeof flags.mode === 'string' ? flags.mode : 'scan',
		url: typeof flags.url === 'string' ? flags.url : null,
		// Load-bearing: without this, opts.domain is undefined, the coverage filter
		// passes every domain, and --record rewrites every baseline — including the
		// reference domain's, from a session where its test server was not running.
		domain: typeof flags.domain === 'string' ? flags.domain : null,
		port: Number(flags.port ?? 3001),
		budget: Number(flags.budget ?? 3),
		limit: Number(flags.limit ?? 60),
		timeout: Number(flags.timeout ?? 20_000),
		settle: Number(flags.settle ?? 5_000),
		json: flags.json === true,
		// Default on: see the flag docs above. `--sweep` stays accepted so existing
		// commands and docs keep working, and now means the same as the default.
		sweep: flags['no-sweep'] !== true,
		help: flags.help === true || flags.h === true,
	};
}

// ─── Pure analysis ───────────────────────────────────────────────────

/** Query and body keys that mean "this endpoint pages". */
export const PAGINATION_KEYS = [
	'page',
	'offset',
	'cursor',
	'limit',
	'start',
	'skip',
	'after',
	'before',
	'page_size',
	'pagesize',
	'per_page',
	'from',
];

/**
 * Pagination parameters visible on a traffic entry.
 *
 * Checks the query string and, when the body is JSON-ish, its top-level keys —
 * a POST that pages via its body is the case a URL-only scan misses.
 */
export function paginationParams(entry) {
	const found = new Set();
	try {
		const url = new URL(entry.url, 'http://placeholder.invalid');
		for (const [key] of url.searchParams) {
			if (PAGINATION_KEYS.includes(key.toLowerCase())) found.add(key);
		}
	} catch {
		/* an unparseable URL contributes nothing */
	}

	const body = entry.requestBody;
	if (body && typeof body === 'object' && !Array.isArray(body)) {
		for (const key of Object.keys(body)) {
			if (PAGINATION_KEYS.includes(key.toLowerCase())) found.add(key);
		}
	}
	return [...found];
}

/** Content type of a traffic entry, lowercased, header-casing tolerant. */
export function contentTypeOf(entry) {
	const headers = entry.responseHeaders ?? {};
	const key = Object.keys(headers).find((h) => h.toLowerCase() === 'content-type');
	return key ? String(headers[key]).toLowerCase() : '';
}

/**
 * Signatures per transport, keyed by the EXACT elimination-table row name.
 *
 * One table, two consumers: the source scanner and the classifier. Keeping the
 * transport list in two places is how the previous version drifted — the
 * elimination table had an "Embedded JSON" row and the scanner had no embedded
 * detection at all, so nothing could contradict a wrong ✗ on it.
 *
 * Evidence is layered by strength, because the layers mean different things:
 *
 *  - `strong`  — the API itself. `new WebSocket(` in a bundle means WebSocket
 *                code exists. A ✗ against a strong hit is a contradiction, and
 *                the tool should say so rather than leave it to judgment.
 *  - `library` — a dependency that implies the transport. Weaker: a bundled
 *                library may be dead code, so this raises suspicion rather
 *                than settling the row.
 *  - `wire`    — content types and URL shapes seen on the network.
 *
 * Add a transport by adding a row here. Nowhere else.
 */
export const TRANSPORT_SIGNATURES = {
	'Embedded JSON': {
		scope: 'html',
		strong: [
			/__NEXT_DATA__/,
			// Next.js App Router (13.4+) does NOT emit __NEXT_DATA__ — it streams RSC
			// Flight chunks via self.__next_f.push(...). Checking only the old marker
			// reports every modern Next.js site as having no embedded data.
			/self\.__next_f|__next_f\.push/,
			/text\/x-component/,
			/_next\/static\/chunks\/app\//,
			/__staticRouterHydrationData/,
			/qwik\/json|q:container/,
			/data-sveltekit-fetched/,
			/__NUXT_DATA__|__NUXT__/,
			/__remixContext/,
			/__PRELOADED_STATE__|__INITIAL_STATE__/,
			/__APOLLO_STATE__/,
			/astro-island/,
			/ng-state|TransferState/,
			/__RELAY_PAYLOADS__/,
			/data-server-rendered/,
			// Semantic markup, which is a different affordance from framework
			// hydration and was missing entirely. Every pattern above names a
			// framework; these are standards, so they can be read without knowing
			// what built the page — and they are on a large share of the web
			// because search engines ask for them. A page carrying no hydration
			// payload at all routinely carries the record you want right here.
			/application\/ld\+json/,
			/itemtype=["'][^"']*schema\.org/,
			/<meta[^>]+property=["']og:/,
			/<meta[^>]+name=["']twitter:/,
			/itemprop=/,
		],
		library: [/<script[^>]+type=["']application\/json["']/],
		wire: [],
	},
	'JSON API (XHR)': {
		scope: 'both',
		strong: [
			/\bfetch\s*\(/,
			/XMLHttpRequest/,
			/\.ajax\s*\(/,
			// RPC-over-HTTP. A Server Action is a POST with a Next-Action header and
			// no URL of its own, so no path scan will ever surface it.
			/\/api\/trpc\//,
			/["']jsonrpc["']\s*:\s*["']2\.0/,
			/Next-Action/i,
			/\$ACTION_ID_|"use server"/,
			/\/odata\//i,
		],
		library: [/axios/, /superagent/, /ky\b/, /got\b/, /swr\b/, /react-query|tanstack/],
		wire: [/application\/json/],
	},
	'HTML-over-the-wire': {
		scope: 'both',
		// A transport class the table lacked entirely: the response body IS markup,
		// so a scanner looking for JSON finds nothing and the data hides in plain
		// sight. htmx and Turbo swap fragments; those endpoints are real APIs.
		strong: [
			/\bhx-(get|post|put|delete|swap|target|trigger)\b/,
			/turbo-stream|data-turbo/,
			/text\/vnd\.turbo-stream\.html/,
		],
		library: [/htmx\.org|htmx\.min/, /@hotwired\/turbo|turbolinks/, /unpoly/],
		wire: [/text\/vnd\.turbo-stream\.html/],
	},
	GraphQL: {
		scope: 'both',
		strong: [/\/graphql\b/, /\/gql\b/, /__schema/, /operationName/],
		library: [
			/@apollo|apollo-client/,
			/urql/,
			/relay-runtime/,
			/graphql-request/,
			/graphql-ws|subscriptions-transport-ws/,
		],
		wire: [/application\/graphql/],
	},
	WebSocket: {
		scope: 'both',
		strong: [/new WebSocket\s*\(/, /wss:\/\//],
		library: [
			/socket\.io/,
			/sockjs/,
			/signalr/,
			/pusher/,
			/ably/,
			/pubnub/,
			/centrifuge/,
			/phoenix\.js|phoenix_html/,
			/reconnecting-websocket/,
		],
		wire: [/upgrade:\s*websocket/i],
	},
	WebTransport: {
		scope: 'both',
		// HTTP/3 datagrams and streams — invisible to CDP Network capture entirely.
		strong: [/new WebTransport\s*\(/, /WebTransportBidirectionalStream/],
		library: [/webtransport/i],
		wire: [],
	},
	WebRTC: {
		scope: 'both',
		// Data channels carry application data, not just media, and nothing in HTTP
		// capture ever sees them.
		strong: [/new RTCPeerConnection\s*\(/, /createDataChannel\s*\(/],
		library: [/simple-peer|peerjs|livekit|mediasoup/],
		wire: [/application\/sdp/],
	},
	// Named for the format that dominates it, but the row is adaptive media in
	// general: DASH manifests, Smooth Streaming, and SMIL all answer the same
	// question — is the media delivered as a manifest plus segments, or as a file.
	'HLS/Media': {
		scope: 'both',
		strong: [/\.m3u8/, /\.mpd\b/, /MediaSource/, /SourceBuffer/],
		library: [
			/hls\.js|hlsjs/,
			/dash\.js|dashjs/,
			/shaka-player|shaka/,
			/video\.js|videojs/,
			/jwplayer/,
			/bitmovin/,
		],
		wire: [
			/application\/dash\+xml/,
			/application\/vnd\.ms-sstr\+xml/,
			/application\/vnd\.apple\.mpegurl|application\/x-mpegurl|application\/dash\+xml/,
		],
	},
	'gRPC-Web': {
		scope: 'both',
		strong: [/grpc-web/, /application\/grpc/],
		library: [/@improbable-eng/, /grpc-web-client/, /connectrpc|@connectrpc/],
		wire: [/application\/grpc-web(\+proto|-text)?/],
	},
	SSE: {
		scope: 'both',
		strong: [/new EventSource\s*\(/, /text\/event-stream/],
		library: [/eventsource-parser|@microsoft\/fetch-event-source/, /sse\.js/],
		wire: [/text\/event-stream/],
	},
	'Encoded/Binary': {
		scope: 'both',
		library: [
			/protobufjs|google-protobuf/,
			/flatbuffers/,
			/msgpack|@msgpack/,
			/avsc|avro/,
			/cbor/,
			/base64-js/,
		],
		strong: [/protobuf/, /\.proto\b/, /ArrayBuffer|Uint8Array/, /atob\s*\(/],
		wire: [/application\/octet-stream|application\/x-protobuf/],
	},
	// The rows below name transports the runtime instrument can prove by the
	// primitive the page reached for. They carry signatures anyway, because a
	// signature is what turns "we never saw it fire" into "here is where it is
	// constructed, go make it fire" — the cheap half of closing a ✗.
	JSONP: {
		scope: 'both',
		// A real API call that the wire files under "script", so it is invisible
		// to any capture that classifies by resource type.
		strong: [/[?&](callback|jsonp)=/i, /createElement\(\s*['"]script['"]\s*\)/, /window\[['"]?cb/],
		library: [/jsonp/],
		wire: [/application\/javascript/],
	},
	'Worker-scoped': {
		scope: 'both',
		// A worker has its own global scope, so nothing patched in the page sees
		// its traffic. Finding the constructor is how you learn where to look.
		strong: [/new\s+(Shared)?Worker\s*\(/, /importScripts\s*\(/, /worker_threads|comlink/],
		library: [/workerize|comlink|partytown/],
		wire: [],
	},
	'Service Worker': {
		scope: 'both',
		// A service worker can answer a fetch from cache, so a request the page
		// made may never reach the network at all.
		strong: [/serviceWorker\.register/, /self\.addEventListener\(\s*['"]fetch/, /workbox/],
		library: [/workbox|sw-precache|next-pwa/],
		wire: [],
	},
	'Cross-frame RPC': {
		scope: 'both',
		// An embedded player or checkout widget does the real fetching inside its
		// own frame and answers the host page over postMessage.
		strong: [
			/postMessage\s*\(/,
			/new\s+BroadcastChannel\s*\(/,
			/addEventListener\(\s*['"]message['"]/,
		],
		library: [/penpal|post-robot|comlink/],
		wire: [],
	},
	'Beacon/Telemetry': {
		scope: 'both',
		// Not an API to wrap, but it names third-party hosts, which is what keeps
		// them out of a coverage count that would otherwise read as a gap.
		strong: [/sendBeacon\s*\(/, /new\s+Image\s*\(\s*\)/, /navigator\.sendBeacon/],
		library: [/segment|amplitude|mixpanel|datadog|sentry/],
		wire: [/text\/plain/],
	},
	// The canonical realtime list is polling, long-polling, WebSocket, SSE and
	// gRPC-Web. Three of those had rows and two did not, so a site whose feed is
	// a long-poll or a streamed body was recorded as having no realtime transport
	// — both are ordinary requests at the wire and only differ in how they are
	// used.
	'Polling/Long-poll': {
		scope: 'both',
		strong: [
			/setInterval\s*\([^)]*fetch/,
			/setTimeout\s*\([^)]*(?:poll|refresh|tick)/i,
			/\bpoll(?:ing)?\b\s*[({]/i,
			/[?&](?:since|after|last(?:_|-)?(?:id|seen|update)|timeout|wait)=/i,
			/long[-_]?poll/i,
		],
		library: [/swr\b|react-query|tanstack|@tanstack\/query/],
		wire: [],
	},
	'Streaming response': {
		scope: 'both',
		strong: [
			/\.body\s*\.\s*getReader\s*\(/,
			/getReader\s*\(\s*\)/,
			/TextDecoderStream|TransformStream|pipeThrough/,
			/ReadableStream/,
		],
		library: [/eventsource-parser|fetch-event-source/],
		wire: [/text\/event-stream|application\/x-ndjson|application\/stream\+json/],
	},
	'Form-encoded POST': {
		scope: 'both',
		// The oldest transport still in use, and the one a JSON-shaped scan misses
		// entirely — server-rendered sites vote, page, and search through it.
		strong: [
			/application\/x-www-form-urlencoded/,
			/new\s+FormData\s*\(/,
			/<form[^>]+method=["']?post/i,
		],
		library: [/qs\b|form-urlencoded/],
		wire: [/application\/x-www-form-urlencoded|multipart\/form-data/],
	},
};

/**
 * Evidence for each transport found in a source, by strength.
 *
 * Returns one entry per transport that matched anything, so a caller can see
 * WHY a transport is suspected and weigh it — a `strong` hit is a claim about
 * the code, a `library` hit is a claim about its dependencies.
 */
/**
 * Markers of our own instrumentation, so a scan never reads it as the target's.
 *
 * The instrument is injected into the page, which means it becomes part of what
 * a source scan sees. It constructs a `WebTransport`, patches `WebSocket`, and
 * carries a `callback=` pattern for JSONP detection — so scanning an
 * instrumented page reported transports that were entirely ours. That is the
 * observation becoming the observed, and it is worse than a plain false
 * positive because the evidence looks exactly like a real hit.
 */
const OWN_INSTRUMENT =
	/__ic_egress|instrumentSource|__ic_drain|data-mw-|patchright-init-script|patchCtor\(|rec\(\{\s*kind:|originals\.set\(/;

/**
 * Remove our own injected source before scanning.
 *
 * Line-granular rather than whole-document: the instrument may be inlined
 * alongside a page's real code, and discarding the whole file would trade a
 * false positive for a blind spot.
 */
export function stripOwnInstrument(source) {
	if (!OWN_INSTRUMENT.test(source)) return source;
	return source
		.split('\n')
		.filter((line) => !OWN_INSTRUMENT.test(line))
		.join('\n');
}

export function transportEvidence(rawSource, kind = 'both') {
	const source = stripOwnInstrument(rawSource);
	const out = {};
	for (const [name, sig] of Object.entries(TRANSPORT_SIGNATURES)) {
		if (sig.scope !== 'both' && kind !== 'both' && sig.scope !== kind) continue;
		const strong = (sig.strong ?? []).filter((re) => re.test(source)).map((re) => re.source);
		const library = (sig.library ?? []).filter((re) => re.test(source)).map((re) => re.source);
		const wire = (sig.wire ?? []).filter((re) => re.test(source)).map((re) => re.source);
		if (strong.length || library.length || wire.length) out[name] = { strong, library, wire };
	}
	return out;
}

/**
 * Rows the agent marked absent that the source contradicts.
 *
 * This is the point of the table: a ✗ is a judgment, and a strong signature is
 * a fact about the code. Where they disagree, the fact wins and the tool says
 * so — rather than leaving a wrong ✗ to survive into a committed domain, which
 * is what happened twice on finance.yahoo.com.
 */
export function contradictions(marks, evidence) {
	return Object.entries(marks)
		.filter(([name, present]) => present === false && (evidence[name]?.strong?.length ?? 0) > 0)
		.map(([name]) => ({ transport: name, strongMatches: evidence[name].strong }));
}

/** Back-compat: transport names with any evidence in a script bundle. */
export function transportMarkers(source) {
	return Object.keys(transportEvidence(source));
}

/**
 * Framework hydration markers — how embedded JSON actually appears in the wild.
 *
 * Checking three framework names and concluding "no embedded JSON" is how a
 * present transport gets recorded absent: measured twice on finance.yahoo.com,
 * where agents probed for `__NEXT_DATA__` and missed SvelteKit's
 * `data-sveltekit-fetched`. A fixed list cannot forget a framework, which is
 * the whole reason this is a table and not a judgment.
 */
export const HYDRATION_MARKERS = [
	['next.js', /__NEXT_DATA__/],
	['sveltekit', /data-sveltekit-fetched|__sveltekit_/],
	['nuxt', /__NUXT_DATA__|__NUXT__/],
	['remix', /__remixContext/],
	['astro', /astro-island/],
	['angular', /ng-state|TransferState/],
	['redux', /__PRELOADED_STATE__|__INITIAL_STATE__|window\.__STATE__/],
	['apollo', /__APOLLO_STATE__/],
	['gatsby', /window\.___chunkMapping|page-data\.json/],
	['vue-ssr', /__VUE_SSR_CONTEXT__|data-server-rendered/],
	['relay', /__RELAY_PAYLOADS__/],
	['generic-json-script', /<script[^>]+type=["']application\/json["']/],
	['generic-window-assign', /window\.__[A-Z_]{4,}__\s*=/],
];

/** Which hydration markers a document carries, with occurrence counts. Pure. */
export function hydrationMarkers(html) {
	const found = [];
	for (const [name, re] of HYDRATION_MARKERS) {
		const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
		const n = (html.match(g) ?? []).length;
		if (n > 0) found.push({ marker: name, count: n });
	}
	return found;
}

/**
 * API-shaped path literals in a script bundle.
 *
 * Traffic capture records what fired; a bundle records what *can* fire. An
 * endpoint present here and absent from traffic is interaction-gated — the
 * thing passive browsing structurally cannot find. Minified bundles build many
 * URLs by concatenation, so this finds a floor, never the full set.
 */
export function endpointLiterals(source, limit = 40) {
	const out = new Set();
	for (const m of source.matchAll(
		/["'`](\/(?:api|v\d+|ws|xhr|graphql|rest|_next\/data)\/[A-Za-z0-9_\-/.{}$:]{2,80})["'`]/g,
	)) {
		out.add(m[1]);
	}
	for (const m of source.matchAll(
		/["'`](https?:\/\/[a-z0-9.-]*(?:api|query|gateway|graph)[a-z0-9.-]*\.[a-z]{2,}\/[A-Za-z0-9_\-/.]{0,60})["'`]/gi,
	)) {
		out.add(m[1]);
	}
	return [...out].slice(0, limit);
}

/** Collapse minified whitespace so a snippet reads in one line. */
function tidy(text) {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Context around each signature hit — the clue, not the verdict.
 *
 * A boolean "WebSocket: present" tells an agent to go looking. The ±window of
 * source around `new WebSocket(` usually contains the URL construction itself:
 * `new WebSocket(n+"/ws/v2?token="+r)` names the path and the auth parameter in
 * one line. That is the difference between knowing a transport exists and
 * knowing where to point at it.
 *
 * Deliberately lossy and capped. Minified source is enormous; the value is a
 * digest small enough to read, so near-duplicates are dropped and the total is
 * bounded. Missing a clue costs a probe; dumping a bundle costs the budget.
 */
export function extractSnippets(rawSource, { window = 90, max = 24 } = {}) {
	const source = stripOwnInstrument(rawSource);
	const out = [];
	const seen = new Set();
	for (const [transport, sig] of Object.entries(TRANSPORT_SIGNATURES)) {
		for (const re of sig.strong ?? []) {
			const g = new RegExp(re.source, `${re.flags.replace('g', '')}g`);
			for (const m of source.matchAll(g)) {
				const from = Math.max(0, m.index - Math.floor(window / 3));
				const snippet = tidy(source.slice(from, m.index + m[0].length + window));
				const key = snippet.slice(0, 48);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({ transport, snippet });
				if (out.length >= max) return out;
			}
		}
	}
	return out;
}

/** API-ish hosts named as string constants, which minification preserves. */
export function extractHosts(source, max = 20) {
	const hosts = new Map();
	for (const m of source.matchAll(
		/["'`]https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(\/[A-Za-z0-9_\-/.]*)?["'`]/gi,
	)) {
		const host = m[1].toLowerCase();
		if (/googletagmanager|google-analytics|doubleclick|facebook|sentry|cdn\.|fonts\./.test(host))
			continue;
		hosts.set(host, (hosts.get(host) ?? 0) + 1);
	}
	return [...hosts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, max)
		.map(([host, n]) => ({ host, n }));
}

/**
 * Clues that multiply everything else, so they are reported first.
 *
 * A sourcemap turns minified source back into original names — the single
 * highest-value find, and one grep away. A build manifest lists routes
 * outright. Persisted GraphQL queries mean the endpoint takes a hash rather
 * than a query string, which changes how a route must be written.
 */
export function extractHighValueClues(source) {
	const clues = [];
	for (const m of source.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)) {
		clues.push({ kind: 'sourcemap', value: m[1], why: 'fetch it for original, unminified source' });
	}
	for (const m of source.matchAll(
		/["'`](\/[A-Za-z0-9_\-/.]*(?:_buildManifest|routes-manifest|asset-manifest|openapi|swagger)[A-Za-z0-9_\-/.]*)["'`]/gi,
	)) {
		clues.push({ kind: 'manifest', value: m[1], why: 'may enumerate routes directly' });
	}
	for (const m of source.matchAll(/["']?(?:sha256Hash|persistedQuery)["']?\s*:/g)) {
		clues.push({
			kind: 'persisted-graphql',
			value: m[0],
			why: 'endpoint takes a query hash, not a query string',
		});
		break;
	}
	for (const m of source.matchAll(/operationName["']?\s*[:=]\s*["']([A-Za-z0-9_]{3,40})["']/g)) {
		clues.push({ kind: 'graphql-operation', value: m[1], why: 'a named query to replay' });
	}
	const headerPatterns = [
		/["']((?:x-)[a-z0-9-]{2,30}(?:id|key|token|version|auth|crumb|sig)[a-z0-9-]*)["']/gi,
		/["'](client-id|client_id|api-key|apikey|authorization|csrf-token|device-id)["']/gi,
	];
	for (const re of headerPatterns) {
		for (const m of source.matchAll(re)) {
			clues.push({ kind: 'auth-header', value: m[1], why: 'header the API expects' });
		}
	}
	const seen = new Set();
	return clues
		.filter((c) => {
			const k = `${c.kind}:${c.value}`;
			if (seen.has(k)) return false;
			seen.add(k);
			return true;
		})
		.slice(0, 20);
}

/** Third parties whose traffic is telemetry, not the site's own API. */
const NOISE =
	/google-analytics|googletagmanager|googlesyndication|doubleclick|googleadservices|facebook\.|fbcdn|scorecardresearch|quantserve|amplitude|segment\.|mixpanel|sentry|bugsnag|newrelic|datadoghq|hotjar|optimizely|branch\.io|adservice|criteo|taboola|outbrain|pubmatic|rubiconproject|casalemedia|openx|ssp\.|adnxs|\.ads?\.|consent|cookielaw|onetrust|gstatic|fonts\.|recaptcha/i;

/** Endpoint identity: host + path with volatile id segments templated. Pure. */
export function normalizeEndpoint(rawUrl) {
	let host = '';
	let path = rawUrl;
	try {
		const u = new URL(rawUrl, 'http://placeholder.invalid');
		host = u.host === 'placeholder.invalid' ? '' : u.host;
		path = u.pathname;
	} catch {
		/* keep the raw string */
	}
	const templated = path
		.split('/')
		.map((seg) => {
			if (/^\d{2,}$/.test(seg)) return '{id}';
			if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return '{uuid}';
			if (/^[0-9a-f]{24,}$/i.test(seg)) return '{hash}';
			if (/^[A-Z0-9._-]{2,}$/.test(seg) && /\d/.test(seg) && seg.length > 3) return '{id}';
			return seg;
		})
		.join('/');
	return host ? `${host}${templated}` : templated;
}

/**
 * Does a declared upstream pattern cover a captured endpoint?
 *
 * Compared segment by segment so a `{placeholder}` matches whatever actually
 * filled it — `www.reddit.com/r/{sub}.json` covers `www.reddit.com/r/all.json`.
 * A plain string comparison cannot: the declaration names the shape, the
 * capture names one instance of it.
 */
export function upstreamMatches(pattern, endpoint) {
	// Two traps here, both found the hard way. URL normalization percent-encodes
	// braces, so `{sub}` arrives as `%7Bsub%7D`; and a placeholder often carries
	// the upstream's extension, so `{sub}.json` fails a `}$` anchor. Decode and
	// strip the extension BEFORE testing whether a segment is a placeholder.
	const clean = (x) => {
		let v = x;
		try {
			v = decodeURIComponent(v);
		} catch {
			/* leave it encoded */
		}
		return v.replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase();
	};
	const p = pattern.split('/');
	const e = endpoint.split('/');
	if (p.length > e.length) return false;
	return p.every((seg, i) => {
		const c = clean(seg);
		if (/^\{.*\}$/.test(c)) return true;
		return c === clean(e[i] ?? '');
	});
}

/**
 * The recall floor: endpoints the browser demonstrably called, against the
 * routes actually built.
 *
 * Captured traffic is the one ground truth available without a manifest — an
 * endpoint that fired provably exists. It is a FLOOR, not a full answer:
 * interaction-gated endpoints never fire under passive browsing, so the real
 * surface is larger than this and the number below is optimistic.
 *
 * Correlation is deliberately weak. A built route is `/api/<domain>/games`
 * while the endpoint it consumes is `gql.twitch.tv/gql` — the names share
 * nothing, and a handler's upstream call is not declared anywhere. So this
 * matches only where a route's path or examples visibly mention a fragment of
 * the endpoint, and reports everything else as unaccounted rather than
 * guessing. An unaccounted endpoint is a question for the agent, not a verdict.
 */
export function coverageDiff(entries = [], routes = [], examples = [], upstream = []) {
	const haystack = [...routes, ...examples].join(' ').toLowerCase();
	// A declared upstream is an exact claim; the heuristic below is a guess. Where
	// a route says what it consumes, believe it. Declared values are written
	// scheme-less (`www.reddit.com/r/{sub}.json`), so give them one before
	// normalizing — otherwise the whole host parses as a path segment.
	const declared = upstream.map((u) => {
		const bare = u.replace(/^[A-Z]+ /, '').trim();
		return normalizeEndpoint(/^https?:\/\//.test(bare) ? bare : `https://${bare}`);
	});

	const endpoints = new Map();
	for (const e of entries) {
		// A document used to be skipped here on the reasoning that a page is not an
		// endpoint. On a server-rendered site the page *is* the endpoint — the
		// records arrive in the markup and there is no other call — so the site's
		// only real transport was structurally invisible to this diff and recall
		// read near zero while every endpoint was in fact accounted for. Frames
		// stay out: a frame is a message on a connection, not an address.
		if (e.method === 'WS-FRAME') continue;
		if (NOISE.test(e.url)) continue;
		const key = normalizeEndpoint(e.url);
		if (!key || key === '/') continue;
		endpoints.set(key, (endpoints.get(key) ?? 0) + 1);
	}

	// Match on ANY meaningful path segment, not just the last one. Reddit's
	// /r/all.json is served by a route at /r/:subreddit — they share the segment
	// "r", which a tail-only check with a length floor of 3 discards outright,
	// reporting 0% coverage for a domain with eight working routes. Extensions are
	// stripped, since a route path never carries the upstream's .json suffix, and
	// structural segments are ignored so every endpoint does not match on "api".
	const STOPWORDS = new Set(['api', 'v1', 'v2', 'v3', 'www', 'com', 'net', 'org', 'svc', 'ws']);
	const accounted = [];
	const unaccounted = [];
	for (const [endpoint, hits] of endpoints) {
		const segments = endpoint
			.split('/')
			.slice(1)
			.filter((x) => x && !x.startsWith('{'))
			.map((x) => x.replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase())
			.filter((x) => x.length >= 2 && !STOPWORDS.has(x));
		const match =
			declared.some((d) => upstreamMatches(d, endpoint)) ||
			segments.some((seg) => haystack.includes(seg));
		(match ? accounted : unaccounted).push({ endpoint, hits });
	}

	const total = accounted.length + unaccounted.length;
	return {
		total,
		accounted: accounted.sort((a, b) => b.hits - a.hits),
		unaccounted: unaccounted.sort((a, b) => b.hits - a.hits),
		recallFloor: total === 0 ? null : Math.round((accounted.length / total) * 100),
	};
}

/**
 * What a traffic capture says about the site, as a verdict.
 *
 * "Nothing found" and "nothing captured" look identical in a bare listing and
 * mean opposite things — one is a finding about the site, the other a broken
 * setup. Naming them apart is the difference between recording a site as static
 * and noticing the browser was never connected.
 */
export function captureVerdict(entries) {
	if (entries.length === 0) {
		return {
			verdict: 'no-capture',
			detail:
				'Zero entries. Only WS-connected browsers capture traffic — this usually means no ' +
				'browser is connected, not that the site is quiet. Connect one and navigate before scanning.',
		};
	}
	const dataEntries = entries.filter((e) => e.method !== 'DOCUMENT' && e.method !== 'WS-FRAME');
	if (dataEntries.length === 0) {
		return {
			verdict: 'document-only',
			detail:
				'Only document responses. The page fetched no data of its own, so the data is either ' +
				'embedded in the HTML or arrives on a page this session has not visited. Run --mode=sources next.',
		};
	}
	return { verdict: 'has-data-traffic', detail: `${dataEntries.length} data request(s) captured` };
}

/** Group traffic entries into a per-endpoint summary. Pure. */
export function summarize(entries) {
	const byEndpoint = new Map();
	for (const entry of entries) {
		let pathname = entry.url;
		try {
			pathname = new URL(entry.url, 'http://placeholder.invalid').pathname;
		} catch {
			/* keep the raw URL */
		}
		const key = `${entry.method} ${pathname}`;
		const existing = byEndpoint.get(key) ?? {
			key,
			count: 0,
			statuses: new Set(),
			contentTypes: new Set(),
			pagination: new Set(),
		};
		existing.count++;
		existing.statuses.add(entry.status);
		const ct = contentTypeOf(entry);
		if (ct) existing.contentTypes.add(ct.split(';')[0]);
		for (const p of paginationParams(entry)) existing.pagination.add(p);
		byEndpoint.set(key, existing);
	}
	return [...byEndpoint.values()]
		.map((e) => ({
			endpoint: e.key,
			count: e.count,
			statuses: [...e.statuses],
			contentTypes: [...e.contentTypes],
			pagination: [...e.pagination],
		}))
		.sort((a, b) => b.pagination.length - a.pagination.length || b.count - a.count);
}

/**
 * Selectors a site uses for "next page" / "load more".
 *
 * Tried ONE AT A TIME, in order. A comma-joined `querySelector` returns the
 * first match in *document* order across all selectors — so an unrelated header
 * element whose class contains "more" wins over the real pagination control at
 * the bottom of the page. Measured on Hacker News 2026-07-28: the joined form
 * clicked an element with empty text and no effect.
 *
 * Within one selector the LAST match is preferred: pagination controls sit
 * below the list they page.
 */
export const PAGINATION_SELECTORS = [
	'[class*=more]',
	'[class*=load]',
	'[class*=next]',
	'[aria-label*=next]',
	'[aria-label*=Next]',
	'[data-testid*=next]',
	'button[rel=next]',
	'a[rel=next]',
];

/**
 * Fallback renderer for a server that predates `table` in the manifest response.
 *
 * The live path prints what the API rendered with the shared renderer, so this
 * exists only so an older server degrades to a readable table rather than to
 * nothing. Two copies of a format drift; one copy plus a stated fallback does
 * not.
 */
export function renderTransportTable(verdicts) {
	const rows = verdicts.map(
		(v) =>
			`| ${v.transport} | ${v.present ? '✓' : '✗'} | ${(v.evidence ?? []).join('; ') || '(not observed)'} |`,
	);
	return ['| Transport | Present | Evidence |', '|---|---|---|', ...rows].join('\n');
}

/**
 * Fetch a script the browser cannot reach, and say which rung was used.
 *
 * The browser goes first because it carries the session. A worker script is a
 * static public asset on a CDN, though, and a cross-origin request for one is
 * refused by CORS from inside the page — the browser is the wrong instrument
 * for it, not a blocked one. Falling back to direct HTTP here is the transport
 * ladder working rather than being skipped: elimination showed the browser
 * cannot reach it and nothing about the asset needs a session.
 */
async function fetchScriptSource(base, url, timeout) {
	const viaBrowser = await api(
		base,
		'/browser/mcp/fetch',
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ url }),
		},
		timeout,
	).catch(() => null);
	if (typeof viaBrowser?.body?.data === 'string' && viaBrowser.body.data.length) {
		return { text: viaBrowser.body.data, via: 'browser' };
	}
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		const res = await fetch(url, { signal: controller.signal });
		clearTimeout(timer);
		if (!res.ok) return { text: '', via: `direct HTTP ${res.status}` };
		return { text: await res.text(), via: 'direct' };
	} catch (err) {
		return { text: '', via: `unreachable: ${String(err).slice(0, 60)}` };
	}
}

// ─── Runner ──────────────────────────────────────────────────────────

const HELP = `discover-probe — the mechanical half of the discovery protocol

  node scripts/discover-probe.mjs --mode=scan|sources|coverage|paginate|probe|graphql|bundles
                                  [--url=PATH] [--port=N] [--budget=N]
                                  [--limit=N] [--timeout=MS] [--settle=MS] [--json]

Read the header docblock in this file for the bounds this run will respect.`;

async function api(base, path, init, timeout) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);
	try {
		const res = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
		const text = await res.text();
		try {
			return { status: res.status, body: JSON.parse(text) };
		} catch {
			return { status: res.status, body: null, text };
		}
	} finally {
		clearTimeout(timer);
	}
}

/** Run a snippet in the connected browser. Fails loudly when none is connected. */
async function evaluate(base, script, timeout) {
	const res = await api(
		base,
		'/browser/mcp/evaluate',
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ script }),
		},
		timeout,
	);
	if (res.status !== 200) {
		throw new Error(
			`browser evaluate failed (HTTP ${res.status}). Is a browser connected over the WebSocket? See docs/ARCHITECTURE.md.`,
		);
	}
	return res.body;
}

async function getTraffic(base, timeout) {
	const res = await api(base, '/browser/traffic', undefined, timeout);
	if (res.status !== 200) {
		throw new Error(`GET /browser/traffic returned HTTP ${res.status}. Is the API server running?`);
	}
	return res.body?.entries ?? [];
}

function printSummary(rows, limit) {
	if (rows.length === 0) return;
	console.log(`${rows.length} endpoint(s), pagination-bearing first:\n`);
	for (const r of rows.slice(0, limit)) {
		const pag = r.pagination.length ? `  ← pagination: ${r.pagination.join(', ')}` : '';
		console.log(`  ${r.endpoint}`);
		console.log(
			`      ${r.count}× · ${r.statuses.join(',')} · ${r.contentTypes.join(',') || 'no content-type'}${pag}`,
		);
	}
	if (rows.length > limit)
		console.log(`\n⊘ ${rows.length - limit} more not shown (--limit=${limit}).`);

	const paged = rows.filter((r) => r.pagination.length > 0);
	if (paged.length > 0) {
		console.log(`\n${paged.length} endpoint(s) carry pagination parameters. Test page 2 directly:`);
		console.log(`  node scripts/discover-probe.mjs --mode=probe --url='<path>?page=2'`);
	}
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(HELP);
		return 0;
	}
	const base = `http://localhost:${opts.port}`;

	if (opts.mode === 'scan') {
		const entries = await getTraffic(base, opts.timeout);
		const rows = summarize(entries);
		const verdict = captureVerdict(entries);
		if (opts.json) {
			console.log(JSON.stringify({ verdict, endpoints: rows }, null, '\t'));
			return 0;
		}
		console.log(`Verdict: ${verdict.verdict}\n  ${verdict.detail}\n`);
		printSummary(rows, opts.limit);
		return 0;
	}

	if (opts.mode === 'paginate') {
		const before = await getTraffic(base, opts.timeout);
		const beforeIds = new Set(before.map((e) => e.id));
		console.log(`Traffic before: ${before.length} entries.`);

		const urlBefore = (await evaluate(base, 'location.href', opts.timeout))?.result;

		const clicked = await evaluate(
			base,
			`(() => {
				for (const sel of ${JSON.stringify(PAGINATION_SELECTORS)}) {
					const all = document.querySelectorAll(sel);
					if (!all.length) continue;
					// Last match: a pagination control sits below the list it pages.
					const el = all[all.length - 1];
					const text = (el.textContent || '').trim().slice(0, 40);
					el.click();
					return { selector: sel, text, tag: el.tagName.toLowerCase(), matches: all.length };
				}
				return { selector: null };
			})()`,
			opts.timeout,
		);
		const hit = clicked?.result;
		if (!hit?.selector) {
			console.log('Trigger: no pagination control matched any known selector.');
			console.log('  The control may be custom. Find it by hand, then click it via the browser.');
			return 0;
		}
		console.log(
			`Trigger: <${hit.tag}> "${hit.text || '(no text)'}" via ${hit.selector} (${hit.matches} match(es))`,
		);
		if (!hit.text) {
			console.log('  ⚠ The clicked element has no text — likely not the pagination control.');
		}

		await new Promise((r) => setTimeout(r, opts.settle));
		const urlAfter = (await evaluate(base, 'location.href', opts.timeout))?.result;
		const after = await getTraffic(base, opts.timeout);
		const fresh = after.filter((e) => !beforeIds.has(e.id));

		console.log(`Traffic after: ${after.length} entries (${fresh.length} new).\n`);

		// A full-page navigation resets the traffic buffer, so "0 new" after one
		// means the page turned over — not that the click did nothing. Reporting
		// those two the same way is how a paginating site gets recorded as static.
		if (urlBefore !== urlAfter) {
			console.log(`↪ The page NAVIGATED: ${urlBefore} → ${urlAfter}`);
			console.log('  This is link-based pagination, not XHR. The URL pattern IS the mechanism —');
			console.log('  record it and fetch further pages by URL. Traffic resets on navigation, so');
			console.log('  a low "new" count here says nothing about whether an XHR API exists.');
			return 0;
		}

		if (fresh.length === 0) {
			console.log('No new requests. That does NOT mean there is no XHR API — the data may have');
			console.log('been prefetched, a service worker may have served it, or the request may have');
			console.log('been deduplicated. Scan for pagination parameters and probe page 2 directly:');
			console.log('  node scripts/discover-probe.mjs --mode=scan');
			return 0;
		}
		printSummary(summarize(fresh), opts.limit);
		return 0;
	}

	if (opts.mode === 'probe') {
		if (!opts.url) {
			console.error('✗ --mode=probe requires --url.');
			return 1;
		}
		// Through the browser, so it carries the session that makes it work.
		const res = await api(
			base,
			'/browser/mcp/fetch',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: opts.url }),
			},
			opts.timeout,
		);
		console.log(JSON.stringify(res.body ?? res.text, null, '\t')?.slice(0, 4000));
		return res.status === 200 ? 0 : 1;
	}

	if (opts.mode === 'graphql') {
		const url = opts.url ?? '/graphql';
		const res = await api(
			base,
			'/browser/mcp/fetch',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					url,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: { query: '{__schema{queryType{fields{name}}}}' },
				}),
			},
			opts.timeout,
		);
		const fields =
			res.body?.data?.data?.__schema?.queryType?.fields ??
			res.body?.data?.__schema?.queryType?.fields;
		if (Array.isArray(fields)) {
			console.log(`GraphQL confirmed at ${url}. ${fields.length} root queries:`);
			for (const f of fields) console.log(`  ${f.name}`);
		} else {
			console.log(`No schema returned from ${url}. Raw response:`);
			console.log(JSON.stringify(res.body ?? res.text)?.slice(0, 1500));
		}
		return 0;
	}

	if (opts.mode === 'coverage') {
		// Recall is read off the manifest, not off raw traffic, so there is one
		// answer to "what did we miss" rather than two that can disagree. The
		// reduction also fixes the denominator: an endpoint called two hundred
		// times is one call shape, and counting it two hundred times made a busy
		// page look better covered than a quiet one.
		//
		// Non-draining, because this only looks. Draining here would consume the
		// events the next manifest call needs.
		const man = await api(base, '/browser/manifest?drain=false', undefined, opts.timeout);
		const rows = man.status === 200 ? (man.body?.rows ?? []) : [];
		const entries =
			rows.length > 0
				? rows.map((r) => ({ method: r.method, url: r.example }))
				: await getTraffic(base, opts.timeout);
		const index = await api(base, '/api', undefined, opts.timeout);
		const doms = (index.body?.domains ?? []).filter((d) => !opts.domain || d.name === opts.domain);
		const routes = doms.flatMap((d) => d.routes ?? []);
		const examples = doms.flatMap((d) => d.examples ?? []);

		const up = doms.flatMap((d) => d.upstream ?? []);
		const diff = coverageDiff(entries, routes, examples, up);
		if (diff.total === 0) {
			console.log(captureVerdict(entries).detail);
			return 1;
		}

		console.log(
			`${routes.length} route(s) built. ${diff.total} distinct call shape(s) the browser actually made.`,
		);

		// A thin sample scores well for the wrong reason. Loading a freshly written
		// domain needs a server restart, the restart clears the capture, and a
		// coverage run after it scores the routes against the handful of calls the
		// checker itself just made — which is close to scoring them against
		// themselves. That reports high coverage and means nothing, and a high
		// number is exactly what nobody re-examines.
		if (diff.total > 0 && diff.total < routes.length) {
			console.log();
			console.log(
				`SAMPLE TOO THIN: ${diff.total} call shape(s) against ${routes.length} route(s). This is not a`,
			);
			console.log(
				'coverage measurement. Capture is cleared by a server restart, so run this while the',
			);
			console.log(
				'discovery session traffic is still present — before restarting to load a new domain.',
			);
		}
		console.log(`Recall floor: ~${diff.recallFloor}% — a FLOOR, because interaction-gated`);
		console.log('endpoints never fire under passive browsing. The real surface is larger.\n');

		if (diff.unaccounted.length) {
			console.log(`${diff.unaccounted.length} endpoint(s) with no visibly matching route:`);
			for (const u of diff.unaccounted.slice(0, 30)) console.log(`  ${u.hits}×  ${u.endpoint}`);
			console.log('\nEach of these fired in a real browser, so each exists. Account for');
			console.log('every one: build a route, or record in the elimination table why not.');
			console.log('Matching is weak by design — a route may cover one of these without');
			console.log('naming it. Unaccounted means unexplained, not necessarily missed.');
		} else {
			console.log('Every captured endpoint has a plausibly matching route.');
		}
		return 0;
	}

	if (opts.mode === 'manifest') {
		// Installing is idempotent, so a second call on an already-instrumented
		// page is free — and asking first would be one more round trip for an
		// answer that changes nothing.
		const install = await api(base, '/browser/instrument', { method: 'POST' }, opts.timeout);
		if (install.status !== 200) {
			console.error(`Instrument failed: ${install.body?.error ?? install.status}`);
			return 1;
		}

		// Exercise before draining: a transport that never fired cannot appear in
		// the manifest, and "not observed" would then read as a verdict.
		let sweep = null;
		if (opts.sweep) {
			const swept = await api(base, '/browser/sweep', { method: 'POST' }, opts.timeout + 60_000);
			if (swept.status !== 200) {
				console.error(`Sweep failed: ${swept.body?.error ?? swept.status}`);
				return 1;
			}
			sweep = swept.body;
		}

		const res = await api(base, '/browser/manifest', undefined, opts.timeout);
		if (res.status !== 200) {
			console.error(`Manifest failed: ${res.body?.error ?? res.status}`);
			return 1;
		}
		const result = res.body ?? {};
		const rows = result.rows ?? [];
		const transports = result.transports ?? [];

		if (opts.json) {
			console.log(JSON.stringify({ ...result, sweep }, null, 2));
			return 0;
		}

		// Rendered upstream by the shared renderer. Re-formatting here would be a
		// second copy of the elimination table's format, and that table is what
		// the whole protocol gates on.
		console.log(result.table ?? renderTransportTable(transports));
		console.log();
		console.log(
			`${rows.length} call shape(s) from ${result.events ?? 0} JS event(s) + ${result.wireEntries ?? 0} wire entr(ies)`,
		);
		// A truncated list presented as a complete one is the failure this whole
		// layer exists to remove, so it is stated rather than left to be noticed.
		if (result.truncatedFrom) {
			console.log(
				`PARTIAL: ${result.truncatedFrom} shapes seen, ${rows.length} reported. Lowest-value rows dropped first`,
			);
			console.log(
				'  (ad and analytics hosts before anything carrying a body or a response shape).',
			);
		}
		console.log();
		const manifestLines = (result.manifestText ?? '').split('\n').filter(Boolean);
		for (const line of manifestLines.slice(0, opts.limit)) console.log(`  ${line}`);
		if (manifestLines.length > opts.limit) {
			console.log(`  … ${manifestLines.length - opts.limit} more (raise --limit)`);
		}

		// An absent row means "not observed", which is weaker than "not present".
		// Saying so here keeps the distinction attached to the output rather than
		// leaving it to be remembered.
		// Stated before the table, because it changes what the table means: a thin
		// result from a watched page is a different finding from a thin result
		// from an unwatched one, and only one of them is about the site.
		const challenges = result.challenges ?? [];
		if (challenges.length) {
			console.log();
			console.log('BOT PROTECTION OBSERVED — this run cannot attribute a block to the site:');
			for (const ch of challenges) {
				console.log(`  ${ch.vendor}: ${ch.evidence.join(', ')}`);
			}
			console.log('  Aids were installed while these fired. If anything is refused from here,');
			console.log(
				"  re-test with --mode=uninstall first before recording it as the site's policy.",
			);
		}

		// A worker has its own global scope, so nothing patched in the page sees
		// what it does — and a socket opened inside one never appears in any
		// capture. That is not a rare corner: a live run found a site's entire
		// realtime feed behind a worker, invisible across four instrumented
		// passes, and only reading the worker's source by hand found it. Reading
		// that source is mechanical, so it happens here.
		const workers = rows.filter((r) => r.kind === 'worker' || r.kind === 'importscripts');
		if (workers.length) {
			console.log();
			console.log(`${workers.length} worker script(s) — their scope is not instrumented:`);
			// A blob-backed worker has no fetchable URL, so its source comes from the
			// capture instead: the instrument reads the blob at the moment it becomes
			// a URL, which is the last point it is readable from outside the page.
			const blobSources = rows
				.filter((r) => r.kind === 'blob-script' && r.body)
				.map((r) => r.body)
				.join('\n');
			if (workers.some((w) => /^blob:/.test(w.example)) && blobSources) {
				const found = Object.keys(transportEvidence(blobSources));
				console.log(
					found.length
						? `  (blob-backed worker sources) -> ${found.join(', ')}`
						: '  (blob-backed worker sources) -> no transport markers',
				);
				for (const h of extractHosts(blobSources, 6)) console.log(`      ${h.host} (${h.n}x)`);

				// A blob worker is usually a bootstrap, not the code. It pulls the real
				// worker in with importScripts, and that URL *is* fetchable — so the
				// chain is blob, then the script it names, and stopping at the blob
				// stops one hop short of where the work happens.
				const hops = [
					...new Set(
						[...blobSources.matchAll(/(?:importScripts|import)\s*\(\s*["']([^"']+)["']/g)].map(
							(m) => m[1],
						),
					),
				].slice(0, 3);
				for (const hop of hops) {
					const { text: hopText, via } = await fetchScriptSource(base, hop, opts.timeout);
					if (!hopText) {
						console.log(`  ${hop} — named by a blob worker, ${via}`);
						continue;
					}
					const hopFound = Object.keys(transportEvidence(hopText));
					console.log(
						hopFound.length
							? `  ${hop} [${via}] -> ${hopFound.join(', ')}`
							: `  ${hop} [${via}] -> no transport markers`,
					);
					for (const h of extractHosts(hopText, 6)) console.log(`      ${h.host} (${h.n}x)`);
				}
			}

			for (const w of workers.slice(0, 5)) {
				if (/^blob:/.test(w.example)) continue;
				const { text } = await fetchScriptSource(base, w.example, opts.timeout);
				if (!text) {
					console.log(`  ${w.example} — source unreadable; read it before ruling its scope out`);
					continue;
				}
				const found = Object.keys(transportEvidence(text));
				console.log(
					found.length
						? `  ${w.example} -> ${found.join(', ')}`
						: `  ${w.example} -> no transport markers in its source`,
				);
				for (const h of extractHosts(text, 5)) console.log(`      ${h.host} (${h.n}x)`);
			}
			console.log('  A transport named here fired where no capture reaches. Treat it as present.');
		}

		if (sweep) {
			console.log();
			console.log(
				`Sweep: ${sweep.performed?.length ?? 0} provocation(s), ${sweep.skipped?.length ?? 0} skipped`,
			);
			for (const s of (sweep.skipped ?? []).slice(0, 5)) console.log(`  skipped: ${s}`);
		}

		const absent = transports.filter((t) => !t.present).map((t) => t.transport);
		if (absent.length) {
			console.log();
			console.log(`Not observed (weaker than absent): ${absent.join(', ')}`);
			console.log(
				opts.sweep
					? 'The page was exercised, so these are better evidence — but still not proof of absence.'
					: 'The page was NOT exercised (--no-sweep). These rows are statements about page load, not about the site.',
			);
		}
		console.log();
		console.log(
			'This session is now instrumented. Run --mode=uninstall before any collection pass.',
		);
		return 0;
	}

	if (opts.mode === 'uninstall') {
		const res = await api(base, '/browser/instrument', { method: 'DELETE' }, opts.timeout);
		if (res.status !== 200) {
			console.error(`Uninstall failed: ${res.body?.error ?? res.status}`);
			return 1;
		}
		const result = res.body ?? {};
		console.log(
			result.clean
				? `Instrument removed. ${result.detail ?? ''}`
				: `INCOMPLETE: nothing could be restored. A collection pass from here is not clean.`,
		);
		// An unreachable frame is a real caveat, just not a blocking one.
		if (result.clean && result.framesUnreachable > 0) {
			console.log('  The main frame is clean; the unreachable frames are third-party.');
		}
		return result.clean ? 0 : 1;
	}

	if (opts.mode === 'sources') {
		const entries = await getTraffic(base, opts.timeout);
		const docs = entries.filter(
			(e) => e.method === 'DOCUMENT' && typeof e.responseBody === 'string',
		);
		const scripts = entries
			.filter((e) => /javascript|ecmascript/.test(contentTypeOf(e)) || /\.js(\?|$)/.test(e.url))
			.slice(0, opts.budget);

		if (docs.length === 0 && scripts.length === 0) {
			console.log(captureVerdict(entries).detail);
			return 1;
		}

		let corpus = docs.map((d) => d.responseBody).join('\n');
		console.log(`Scanned ${docs.length} document(s) for hydration markers:`);
		const markers = hydrationMarkers(corpus);
		if (markers.length === 0)
			console.log('  none — embedded JSON is genuinely absent from these documents');
		for (const m of markers) console.log(`  ${m.marker} ×${m.count}`);

		const endpoints = new Set();
		for (const sc of scripts) {
			const res = await api(
				base,
				'/browser/mcp/fetch',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ url: sc.url }),
				},
				opts.timeout,
			);
			const src = typeof res.body?.data === 'string' ? res.body.data : (res.text ?? '');
			corpus += `\n${src}`;
			for (const e of endpointLiterals(src)) endpoints.add(e);
		}
		console.log(`\nScanned ${scripts.length} script(s).`);

		const clues = extractHighValueClues(corpus);
		if (clues.length) {
			console.log('\nHigh-value clues (chase these first):');
			for (const c of clues) console.log(`  [${c.kind}] ${c.value} — ${c.why}`);
		}

		const hosts = extractHosts(corpus);
		if (hosts.length) {
			console.log('\nAPI-ish hosts named in source:');
			for (const h of hosts) console.log(`  ${h.host} (${h.n}×)`);
		}

		const evidence = transportEvidence(corpus);
		console.log('\nTransport evidence in source:');
		for (const [name, ev] of Object.entries(evidence)) {
			const bits = [];
			if (ev.strong.length) bits.push(`STRONG(${ev.strong.length})`);
			if (ev.library.length) bits.push(`library(${ev.library.length})`);
			if (ev.wire.length) bits.push(`wire(${ev.wire.length})`);
			console.log(`  ${name.padEnd(18)} ${bits.join(' ')}`);
		}
		console.log('\nA STRONG hit is a fact about the code. Marking that row ✗ is a');
		console.log('contradiction — probe it properly before writing the verdict.');

		const snippets = extractSnippets(corpus);
		if (snippets.length) {
			console.log('\nSource context around each hit — usually contains the URL itself:');
			for (const sn of snippets) console.log(`  [${sn.transport}] …${sn.snippet}…`);
		}

		if (endpoints.size) {
			console.log(`\n${endpoints.size} API-shaped path(s) in source. Any absent from captured`);
			console.log('traffic is interaction-gated — drive the page to reach it:');
			for (const e of [...endpoints].slice(0, 25)) console.log(`  ${e}`);
		}
		return 0;
	}

	if (opts.mode === 'bundles') {
		const entries = await getTraffic(base, opts.timeout);
		const scripts = entries
			.filter((e) => /javascript|ecmascript/.test(contentTypeOf(e)) || /\.js(\?|$)/.test(e.url))
			.slice(0, opts.budget);
		if (scripts.length === 0) {
			const verdict = captureVerdict(entries);
			if (verdict.verdict === 'no-capture') {
				console.log(verdict.detail);
				return 1;
			}
			console.log(
				'This page loaded no scripts of its own — that is a finding, not a setup problem.',
			);
			console.log('A site that ships no JavaScript has no client-side transport to find: its data');
			console.log('is in the HTML. Run --mode=sources.');
			return 0;
		}
		for (const s of scripts) {
			const res = await api(
				base,
				'/browser/mcp/fetch',
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ url: s.url }),
				},
				opts.timeout,
			);
			const source = typeof res.body?.data === 'string' ? res.body.data : (res.text ?? '');
			const markers = transportMarkers(source);
			console.log(`${s.url.slice(0, 90)}`);
			console.log(`    ${markers.length ? markers.join(', ') : 'no real-time transport markers'}`);
		}
		console.log('\nMarkers point at where to look. Confirm each against captured traffic');
		console.log('before marking a transport present in the elimination table.');
		return 0;
	}

	console.error(`✗ Unknown --mode=${opts.mode}.\n\n${HELP}`);
	return 1;
}

// Importing runs nothing; a unit test drives the exported analysis directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(`✗ ${err.message}`);
			process.exit(1);
		});
}
