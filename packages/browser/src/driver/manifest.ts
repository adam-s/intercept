/**
 * Egress Manifest
 *
 * A busy page emits hundreds of network events, most of them the same call with
 * a different id. Handing that stream to a model costs a fortune and buries the
 * five rows that matter, so discovery ends up rationing observation — which is
 * the opposite of what breadth needs.
 *
 * This collapses the stream into one row per distinct call shape: the path
 * templated, the query reduced to its keys, one example kept, the response
 * reduced to its key skeleton. A thousand events become a few dozen rows, and
 * the reduction is lossless in the dimension that matters — a call shape that
 * occurred once still gets a row.
 *
 * It also derives the transport elimination table. That table has been written
 * by a model reasoning about what it saw, which is exactly where breadth has
 * been lost: a transport present in the capture but absent from the table reads
 * as absent from the site. Derived from observation, present/absent is a fact
 * with an event behind it, and the model's job narrows to explaining rows
 * rather than remembering them.
 *
 * Pure functions over plain data — no browser, so the whole reduction is unit
 * testable against fixtures.
 *
 * @module browser/driver/manifest
 */

import type { EgressEvent, EgressKind } from './instrument.js';

/** One distinct call shape, however many times it occurred. */
export interface ManifestRow {
	kind: EgressKind | 'wire';
	method: string;
	host: string;
	/** Path with volatile segments replaced by `{id}` — the grouping key. */
	template: string;
	/** Query parameter names, values dropped. Names are the API, values are data. */
	params: string[];
	count: number;
	/** One real URL, so the row can be replayed rather than reconstructed. */
	example: string;
	/** Bounded preview of a request payload seen on this shape. */
	body?: string;
	/** Key skeleton of a response body, when one was captured. */
	shape?: string;
	/** Distinct initiating stack frames — which bundles drive this call. */
	initiators?: string[];
	/** First and last occurrence, ms since instrument install. Polling is only
	 *  visible over time: one call is a request, the same call on a cadence is a
	 *  stream wearing a request's clothes. */
	firstAt?: number;
	lastAt?: number;
}

/**
 * A manifest, plus a note when the reporting cap dropped rows.
 *
 * Carried on the result rather than left implicit: a truncated list presented
 * as a complete one is the failure this whole layer exists to remove, and a
 * caller that cannot tell will present it.
 */
export type Manifest = ManifestRow[] & { truncatedFrom?: number };

/** Bounds, so a pathological page cannot produce a pathological manifest. */
export const MANIFEST_LIMITS = {
	/** Rows reported. Applied after collection, keeping the most informative. */
	maxRows: 200,
	/** Memory guard while collecting. Far above any real page. */
	hardCeiling: 3_000,
	maxInitiators: 3,
	maxShapeKeys: 40,
} as const;

/**
 * Hosts whose traffic is telemetry rather than a site's own data.
 *
 * Used only to decide what to drop first when a page produces more call shapes
 * than can be reported — an ad exchange losing its row costs nothing, a site's
 * own endpoint losing one costs a transport.
 */
const LOW_VALUE_HOST =
	/doubleclick|rubiconproject|adsystem|adnxs|criteo|taboola|outbrain|scorecardresearch|google-analytics|googletagmanager|quantserve|moatads|adsrvr|casalemedia|pubmatic|openx|indexww|3lift|sharethrough|teads|smartadserver|yieldmo|bidswitch|adform|zeta|id5-sync|crwdcntrl|demdex|everesttech|sentry\.io|newrelic|datadoghq/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXISH = /^[0-9a-f]{8,}$/i;
const LONG_OPAQUE = /^(?=.*[0-9])(?=.*[a-z])[a-z0-9_-]{12,}$/i;

/**
 * Replace a path segment that identifies an instance rather than a resource
 * kind. Getting this wrong in either direction is visible: too eager and two
 * different endpoints merge, too shy and one endpoint becomes fifty rows.
 */
export function templateSegment(seg: string): string {
	if (!seg) return seg;
	if (/^\d+$/.test(seg)) return '{id}';
	if (UUID.test(seg)) return '{uuid}';
	if (HEXISH.test(seg)) return '{hash}';
	// A file keeps its extension: `player.js` is a name, `a1b2c3d4.js` is a build hash.
	const dot = seg.lastIndexOf('.');
	if (dot > 0) {
		const stem = seg.slice(0, dot);
		const ext = seg.slice(dot);
		if (UUID.test(stem) || HEXISH.test(stem) || LONG_OPAQUE.test(stem)) return `{id}${ext}`;
		return seg;
	}
	if (LONG_OPAQUE.test(seg)) return '{id}';
	return seg;
}

/**
 * Pseudo-schemes the instrument emits for primitives that have no URL of their
 * own. `new URL` accepts these — they are syntactically valid, just not
 * hierarchical — and returns an empty host, which would silently collapse every
 * data channel and every broadcast into one hostless bucket. Split them first.
 */
const PSEUDO_SCHEME = /^(rtc|bc|pm|mse):/;

/** Split a URL into the parts the manifest groups on. Never throws on junk. */
export function parseTarget(raw: string): { host: string; template: string; params: string[] } {
	const pseudo = PSEUDO_SCHEME.exec(raw);
	if (pseudo) {
		return { host: pseudo[1], template: raw.slice(pseudo[0].length), params: [] };
	}
	try {
		const u = new URL(raw, 'https://relative.invalid');
		const host = u.host === 'relative.invalid' ? '' : u.host;
		const template = u.pathname.split('/').map(templateSegment).join('/');
		return { host, template, params: [...new Set(u.searchParams.keys())].sort() };
	} catch {
		const [scheme, rest = ''] = raw.split(':', 2);
		return { host: scheme, template: rest, params: [] };
	}
}

/**
 * Reduce a JSON body to its key skeleton. The shape is what tells a reader
 * whether two endpoints return the same thing; the values are noise that costs
 * tokens proportional to page size.
 */
export function shapeOfBody(body: unknown, depth = 0): string {
	if (depth > 2) return '…';
	if (body === null) return 'null';
	if (Array.isArray(body)) return body.length ? `[${shapeOfBody(body[0], depth + 1)}]` : '[]';
	if (typeof body === 'object') {
		const keys = Object.keys(body as Record<string, unknown>).slice(
			0,
			MANIFEST_LIMITS.maxShapeKeys,
		);
		if (!keys.length) return '{}';
		const rec = body as Record<string, unknown>;
		return `{${keys.map((k) => `${k}:${shapeOfBody(rec[k], depth + 1)}`).join(',')}}`;
	}
	return typeof body;
}

function keyOf(kind: string, method: string, t: ReturnType<typeof parseTarget>): string {
	return `${kind}|${method}|${t.host}|${t.template}|${t.params.join(',')}`;
}

/**
 * Collapse observed events into distinct call shapes.
 *
 * Wire-level events are folded in under kind `wire` and merged with a
 * JS-level row when they describe the same shape — a call seen by both is one
 * row that says so, not two rows a reader has to reconcile.
 */
export function buildManifest(
	events: EgressEvent[],
	wire: Array<{ method: string; url: string; body?: unknown }> = [],
): Manifest {
	const rows = new Map<string, ManifestRow>();

	const add = (
		kind: ManifestRow['kind'],
		method: string,
		url: string,
		extra: { body?: string; shape?: string; initiator?: string; at?: number },
	) => {
		const t = parseTarget(url);
		const k = keyOf(kind === 'wire' ? 'wire' : kind, method, t);
		let row = rows.get(k);
		if (!row) {
			// Bounded, but not by refusing late arrivals. Dropping at insert time is
			// first-come-first-served, so on a page with a hundred ad hosts the cap
			// filled with whatever loaded first and a transport appearing only in a
			// later row read as absent. The hard ceiling here is a memory guard; the
			// reporting cap is applied at the end, after everything is known and the
			// least informative rows can be the ones to go.
			if (rows.size >= MANIFEST_LIMITS.hardCeiling) return;
			row = {
				kind,
				method,
				host: t.host,
				template: t.template,
				params: t.params,
				count: 0,
				example: url,
			};
			rows.set(k, row);
		}
		row.count += 1;
		if (extra.at !== undefined) {
			row.firstAt = row.firstAt === undefined ? extra.at : Math.min(row.firstAt, extra.at);
			row.lastAt = row.lastAt === undefined ? extra.at : Math.max(row.lastAt, extra.at);
		}
		if (!row.body && extra.body) row.body = extra.body;
		if (!row.shape && extra.shape) row.shape = extra.shape;
		if (extra.initiator) {
			row.initiators ??= [];
			if (
				!row.initiators.includes(extra.initiator) &&
				row.initiators.length < MANIFEST_LIMITS.maxInitiators
			) {
				row.initiators.push(extra.initiator);
			}
		}
	};

	for (const e of events) {
		add(e.kind, e.method, e.url, { body: e.body, initiator: e.initiator, at: e.t });
	}
	for (const w of wire) {
		add('wire', w.method, w.url, { shape: w.body === undefined ? undefined : shapeOfBody(w.body) });
	}

	// Frequent first, but a shape seen once still has a row — a once-only call is
	// often the interesting one, so ordering must not become truncation.
	const all = [...rows.values()].sort(
		(a, b) => b.count - a.count || a.template.localeCompare(b.template),
	);
	if (all.length <= MANIFEST_LIMITS.maxRows) return all as Manifest;

	// Over the reporting cap: drop the rows least likely to carry a transport.
	// A carried response shape or request body is evidence; an ad exchange's
	// pixel is not. Marked so the caller can say the manifest is partial rather
	// than presenting a truncated list as a complete one.
	const value = (r: ManifestRow) =>
		(LOW_VALUE_HOST.test(r.host) ? 0 : 2) + (r.shape || r.body ? 1 : 0);
	const kept = all.sort((a, b) => value(b) - value(a) || b.count - a.count);
	const out = kept.slice(0, MANIFEST_LIMITS.maxRows) as Manifest;
	out.truncatedFrom = all.length;
	return out;
}

/**
 * Which elimination-table row each observed primitive answers.
 *
 * The names are the static scanner's names on purpose. One transport must not
 * be called two things by the two halves of discovery — a scan hinting at
 * "WebRTC" and an observation reporting "WebRTC data channel" produce two rows
 * nobody reconciles, and a wrong verdict in either survives because neither can
 * contradict the other. A repo-level test pins the two lists together.
 *
 * `fetch` and XHR collapse into one row deliberately: the same transport
 * reached through two APIs. Splitting them would report a site that migrated
 * from one to the other as having gained a transport.
 */
const KIND_TO_TRANSPORT: Record<string, string> = {
	fetch: 'JSON API (XHR)',
	xhr: 'JSON API (XHR)',
	wire: 'JSON API (XHR)',
	websocket: 'WebSocket',
	'websocket-frame': 'WebSocket',
	eventsource: 'SSE',
	'stream-response': 'Streaming response',
	beacon: 'Beacon/Telemetry',
	'image-beacon': 'Beacon/Telemetry',
	webrtc: 'WebRTC',
	webtransport: 'WebTransport',
	worker: 'Worker-scoped',
	importscripts: 'Worker-scoped',
	serviceworker: 'Service Worker',
	jsonp: 'JSONP',
	'media-append': 'HLS/Media',
	'form-submit': 'Form-encoded POST',
	postmessage: 'Cross-frame RPC',
	broadcast: 'Cross-frame RPC',
};

/**
 * Every transport name an observation can produce, including the one derived
 * from payload shape rather than from a primitive. Exported so the drift pin
 * can compare it against the scanner's list.
 */
export const OBSERVABLE_TRANSPORTS: string[] = [
	...new Set([
		...Object.values(KIND_TO_TRANSPORT),
		// Settled from payloads rather than from a primitive, but settled from
		// observation all the same — a body carrying `"query":`, and a navigation
		// response carrying markup. Leaving them out of this list told the scorer
		// they were unreachable and made every such row a guaranteed miss.
		'GraphQL',
		'HTML-over-the-wire',
		// Derived from cadence rather than from a primitive, but derived from
		// observation all the same.
		'Polling/Long-poll',
	]),
].sort();

/** A transport row with observation behind it, rather than recollection. */
export interface TransportVerdict {
	transport: string;
	present: boolean;
	/** Call shapes that prove it, empty when absent. */
	evidence: string[];
}

/**
 * Derive present/absent per transport from the manifest.
 *
 * Absent means "no event of this kind was observed", which is weaker than "the
 * site does not have it" — an interaction-gated transport that never fired is
 * absent here and present on the site. The distinction belongs to whoever reads
 * this, so the wording stays mechanical and the sweep exists to narrow the gap.
 */
export function deriveTransports(rows: ManifestRow[]): TransportVerdict[] {
	const seen = new Map<string, string[]>();
	for (const name of Object.values(KIND_TO_TRANSPORT)) if (!seen.has(name)) seen.set(name, []);
	// Reachable from a navigation response, so it belongs to the observable set
	// rather than to the payload-shape rows a scan has to settle.
	if (!seen.has('HTML-over-the-wire')) seen.set('HTML-over-the-wire', []);

	for (const row of rows) {
		// A wire row's kind says it came off the network, not what it carried. A
		// navigation response is markup: filing it under the JSON row put a false
		// ✓ on the row most likely to be believed, while the row it actually
		// belongs to read absent on a site whose entire transport is that markup.
		const name =
			row.kind === 'wire' && row.method === 'DOCUMENT'
				? 'HTML-over-the-wire'
				: KIND_TO_TRANSPORT[row.kind];
		if (!name) continue;
		const ev = seen.get(name);
		if (ev && ev.length < 3) ev.push(`${row.method} ${row.host}${row.template}`);
	}

	// GraphQL rides on fetch/XHR, so it is a body-shape question, not a
	// primitive question — the only verdict here that reads payloads.
	// A bare `"query":` key is not enough. A REST endpoint taking a filter DSL
	// carries one too, and a live run had to disprove the resulting false ✓ by
	// introspecting an endpoint that answered with a REST error shape rather than
	// a GraphQL envelope — work the classifier should not have caused.
	//
	// The discriminator is the value, not the key. A GraphQL `query` is always a
	// string holding a selection set, so it contains braces; a filter DSL passes
	// an object, and a named-screener parameter passes a bare word. Companion
	// keys settle the rest.
	const graphql = rows.filter(
		(r) =>
			/graphql|\/gql\b/i.test(r.template) ||
			(r.body
				? /"query"\s*:\s*"[^"]*\{[^"]*\}/.test(r.body) ||
					(/"query"\s*:\s*"/.test(r.body) &&
						/"(?:variables|operationName|extensions)"\s*:/.test(r.body))
				: false),
	);

	const out: TransportVerdict[] = [...seen.entries()].map(([transport, evidence]) => ({
		transport,
		present: evidence.length > 0,
		evidence,
	}));
	// Adaptive media is provable two ways and the primitive is the weaker one.
	// `appendBuffer` fires only when the page itself demuxes; a player that does
	// its fetching and appending inside a worker leaves no MSE event in the page,
	// so a site streaming video reported this row absent while its playlist sat
	// in the captured traffic. A manifest request settles it whoever made it.
	const media = rows.filter((r) =>
		/\.m3u8|\.mpd|\/hls\/|\/dash\/|\/manifest\/video/i.test(r.template),
	);
	if (media.length) {
		const row = out.find((v) => v.transport === 'HLS/Media');
		if (row) {
			row.present = true;
			for (const m of media.slice(0, 3)) {
				const ev = `${m.method} ${m.host}${m.template}`;
				if (!row.evidence.includes(ev)) row.evidence.push(ev);
			}
		}
	}

	// A primitive says how a call was made, not what it carried. `fetch` and XHR
	// map to the JSON row because that is the common case, so a form-encoded POST
	// sent through `fetch` was filed as a JSON API and its own row printed absent
	// — while the request body sat in the manifest saying otherwise.
	const formEncoded = rows.filter(
		(r) =>
			r.kind === 'form-submit' ||
			(r.body
				? /^[\w.[\]%+-]+=[^&\s]*(&[\w.[\]%+-]+=[^&\s]*)+$/.test(r.body.slice(0, 300))
				: false),
	);
	if (formEncoded.length) {
		const row = out.find((v) => v.transport === 'Form-encoded POST');
		if (row) {
			row.present = true;
			for (const f of formEncoded.slice(0, 3)) {
				const ev = `${f.method} ${f.host}${f.template}`;
				if (!row.evidence.includes(ev)) row.evidence.push(ev);
			}
		}
	}

	// Polling is a stream wearing a request's clothes: the same call shape on a
	// cadence, each one an ordinary GET. Nothing about a single request shows it,
	// which is why a site whose realtime feed is a long-poll gets recorded as
	// having no realtime transport at all. Repetition alone is not enough —
	// pagination repeats too — so this asks for repetition spread over time.
	const POLL_EXCLUDED_KINDS = new Set([
		'websocket',
		'websocket-frame',
		'eventsource',
		'stream-response',
		'media-append',
		'beacon',
		'image-beacon',
	]);
	const polled = rows.filter((r) => {
		// A socket's frames arrive on a cadence by definition, and so do stream
		// chunks and telemetry pings. Counting those as polling marks the row
		// present on any site with a live feed of any kind, which makes it useless.
		if (POLL_EXCLUDED_KINDS.has(r.kind)) return false;
		// Polling re-asks one question; pagination asks the next one. A templated
		// segment means the calls went to different addresses, so a scroll walking
		// through pages is not a poll however evenly spaced it is.
		if (/\{/.test(r.template)) return false;
		if (r.count < 3 || r.firstAt === undefined || r.lastAt === undefined) return false;
		const span = r.lastAt - r.firstAt;
		if (span < 1_000) return false; // a burst, not a cadence
		const gap = span / (r.count - 1);
		return gap >= 400 && gap <= 120_000;
	});
	out.push({
		transport: 'Polling/Long-poll',
		present: polled.length > 0,
		evidence: polled
			.slice(0, 3)
			.map(
				(r) =>
					`${r.method} ${r.host}${r.template} x${r.count} over ${Math.round(((r.lastAt ?? 0) - (r.firstAt ?? 0)) / 1000)}s`,
			),
	});

	out.push({
		transport: 'GraphQL',
		present: graphql.length > 0,
		evidence: graphql.slice(0, 3).map((r) => `${r.method} ${r.host}${r.template}`),
	});
	return out.sort(
		(a, b) => Number(b.present) - Number(a.present) || a.transport.localeCompare(b.transport),
	);
}

/** Compact text for a reader. Optimised for tokens, not for looks. */
export function renderManifest(rows: ManifestRow[]): string {
	const lines = rows.map((r) => {
		const q = r.params.length ? `?${r.params.join('&')}` : '';
		const n = r.count > 1 ? ` x${r.count}` : '';
		const shape = r.shape ? ` -> ${r.shape}` : '';
		const body = r.body ? ` body=${r.body}` : '';
		return `${r.kind} ${r.method} ${r.host}${r.template}${q}${n}${shape}${body}`;
	});
	return lines.join('\n');
}

/** The derived elimination table, ready to paste into a compliance matrix. */
export function renderTransports(verdicts: TransportVerdict[]): string {
	const rows = verdicts.map(
		(v) =>
			`| ${v.transport} | ${v.present ? '✓' : '✗'} | ${v.evidence.join('; ') || '(not observed)'} |`,
	);
	return ['| Transport | Present | Evidence |', '|---|---|---|', ...rows].join('\n');
}

/**
 * Hosts and paths that mean a bot wall is watching this page.
 *
 * Vendor endpoints are recognisable in a manifest even when nothing has been
 * refused yet: a fingerprinting collector fires long before an interstitial
 * does. Seeing one is not a failure — it is the thing that decides whether a
 * later block can be attributed to the site at all.
 */
const CHALLENGE_MARKERS: Array<{ vendor: string; match: RegExp }> = [
	{ vendor: 'Kasada', match: /(^|\.)k\.[\w-]+\.(?:net|com)\/.*\/(?:fp|tl)|kpsdk/i },
	{ vendor: 'DataDome', match: /datadome/i },
	{ vendor: 'PerimeterX / HUMAN', match: /perimeterx|px-cloud|\/px\/xhr/i },
	{ vendor: 'Cloudflare', match: /\/cdn-cgi\/challenge|turnstile/i },
	{ vendor: 'Akamai', match: /akam\/\d|_abck|\/akamai\//i },
	{ vendor: 'hCaptcha', match: /hcaptcha\.com/i },
	{ vendor: 'reCAPTCHA', match: /recaptcha|google\.com\/sorry/i },
];

/** A bot-protection vendor observed in the manifest, with what gave it away. */
export interface ChallengePresence {
	vendor: string;
	evidence: string[];
}

/**
 * Which bot-protection vendors this capture saw.
 *
 * Load-bearing for attribution rather than for defence. A run that carried
 * discovery aids and then hit a wall cannot say whether the wall was the site's
 * policy or a reaction to being instrumented, and recording "this site blocks
 * us" from such a run puts a wrong fact in front of every later attempt.
 * Knowing a vendor was present turns that from something to remember into
 * something the output states.
 */
export function detectChallengePresence(rows: ManifestRow[]): ChallengePresence[] {
	const seen = new Map<string, string[]>();
	for (const row of rows) {
		const target = `${row.host}${row.template}`;
		for (const { vendor, match } of CHALLENGE_MARKERS) {
			if (!match.test(target)) continue;
			const list = seen.get(vendor) ?? [];
			if (list.length < 3 && !list.includes(target)) list.push(target);
			seen.set(vendor, list);
		}
	}
	return [...seen.entries()].map(([vendor, evidence]) => ({ vendor, evidence }));
}
