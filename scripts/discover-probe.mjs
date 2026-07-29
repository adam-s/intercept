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
 *
 * USAGE
 *   node scripts/discover-probe.mjs --mode=scan
 *   node scripts/discover-probe.mjs --mode=paginate
 *   node scripts/discover-probe.mjs --mode=probe --url=/api/items?page=2
 *   node scripts/discover-probe.mjs --mode=graphql --url=/api/graphql
 *   node scripts/discover-probe.mjs --mode=bundles --budget=3
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
		port: Number(flags.port ?? 3001),
		budget: Number(flags.budget ?? 3),
		limit: Number(flags.limit ?? 60),
		timeout: Number(flags.timeout ?? 20_000),
		settle: Number(flags.settle ?? 5_000),
		json: flags.json === true,
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
 * Real-time transport markers in a script bundle.
 *
 * Returns the transports named, never a verdict — a marker means "look here",
 * not "this site uses WebSocket." The elimination table needs the agent to
 * confirm each one against captured traffic.
 */
export function transportMarkers(source) {
	const checks = [
		['websocket', /\bnew WebSocket\(|wss:\/\//],
		['sse', /\bEventSource\b|text\/event-stream/],
		['graphql', /\/graphql\b|\/gql\b|__schema/],
		['grpc-web', /application\/grpc|grpc-web/],
		['hls-dash', /\.m3u8|\.mpd\b|MediaSource/],
		['protobuf', /protobuf|\.proto\b/],
		['webrtc', /RTCPeerConnection|webrtc/i],
	];
	return checks.filter(([, re]) => re.test(source)).map(([name]) => name);
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
				'embedded in the HTML or arrives on a page this session has not visited. Run --mode=embedded next.',
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

// ─── Runner ──────────────────────────────────────────────────────────

const HELP = `discover-probe — the mechanical half of the discovery protocol

  node scripts/discover-probe.mjs --mode=scan|paginate|probe|graphql|bundles
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
		console.log(`Trigger: <${hit.tag}> "${hit.text || '(no text)'}" via ${hit.selector} (${hit.matches} match(es))`);
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
			console.log('This page loaded no scripts of its own — that is a finding, not a setup problem.');
			console.log('A site that ships no JavaScript has no client-side transport to find: its data');
			console.log('is in the HTML. Run --mode=embedded.');
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
