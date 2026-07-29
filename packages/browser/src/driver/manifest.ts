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
}

/** Bounds, so a pathological page cannot produce a pathological manifest. */
export const MANIFEST_LIMITS = { maxRows: 200, maxInitiators: 3, maxShapeKeys: 40 } as const;

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
): ManifestRow[] {
	const rows = new Map<string, ManifestRow>();

	const add = (
		kind: ManifestRow['kind'],
		method: string,
		url: string,
		extra: { body?: string; shape?: string; initiator?: string },
	) => {
		const t = parseTarget(url);
		const k = keyOf(kind === 'wire' ? 'wire' : kind, method, t);
		let row = rows.get(k);
		if (!row) {
			if (rows.size >= MANIFEST_LIMITS.maxRows) return;
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
		add(e.kind, e.method, e.url, { body: e.body, initiator: e.initiator });
	}
	for (const w of wire) {
		add('wire', w.method, w.url, { shape: w.body === undefined ? undefined : shapeOfBody(w.body) });
	}

	// Frequent first, but a shape seen once still has a row — a once-only call is
	// often the interesting one, so ordering must not become truncation.
	return [...rows.values()].sort(
		(a, b) => b.count - a.count || a.template.localeCompare(b.template),
	);
}

/** Which elimination-table row each observed primitive answers. */
const KIND_TO_TRANSPORT: Record<string, string> = {
	fetch: 'JSON API (fetch)',
	xhr: 'JSON API (XHR)',
	wire: 'JSON API (XHR)',
	websocket: 'WebSocket',
	'websocket-frame': 'WebSocket',
	eventsource: 'SSE',
	beacon: 'Beacon / telemetry',
	webrtc: 'WebRTC data channel',
	webtransport: 'WebTransport',
	worker: 'Worker-scoped traffic',
	serviceworker: 'Service worker',
	importscripts: 'Worker-scoped traffic',
	jsonp: 'JSONP',
	'image-beacon': 'Beacon / telemetry',
	'media-append': 'HLS/DASH adaptive media',
	'form-submit': 'Form-encoded POST',
	postmessage: 'Cross-frame RPC',
	broadcast: 'Cross-frame RPC',
};

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

	for (const row of rows) {
		const name = KIND_TO_TRANSPORT[row.kind];
		if (!name) continue;
		const ev = seen.get(name);
		if (ev && ev.length < 3) ev.push(`${row.method} ${row.host}${row.template}`);
	}

	// GraphQL rides on fetch/XHR, so it is a body-shape question, not a
	// primitive question — the only verdict here that reads payloads.
	const graphql = rows.filter(
		(r) => /graphql|\/gql/i.test(r.template) || (r.body ? /"query"\s*:/.test(r.body) : false),
	);
	const out: TransportVerdict[] = [...seen.entries()].map(([transport, evidence]) => ({
		transport,
		present: evidence.length > 0,
		evidence,
	}));
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
