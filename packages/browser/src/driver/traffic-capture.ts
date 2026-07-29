/**
 * Protocol-Agnostic Traffic Capture
 *
 * Traffic capture is this framework's core feature, and it was built on CDP
 * `Network.*` events — which is Chromium-only. This module rebuilds it on
 * Playwright's own `request`/`response` events, which every engine supports.
 *
 * IT IS NOT YET THE CAPTURE THE RUNNING SYSTEM USES. The remote service still
 * runs its own CDP capture, so there are two implementations of one concern and
 * only the other one executes in production. This was found the way such things
 * are: a live run reported adaptive media absent on a page that was visibly
 * streaming, because the CDP session is bound to the page and the site fetches
 * its segments from a worker. Measured against the benchmark, the context-level
 * listener below does see worker traffic and the page-scoped CDP session does
 * not. Unifying on this module is recorded in docs/PLANNED-WORK.md; until then,
 * read any claim about capture coverage as a claim about the CDP path.
 *
 * What changes, honestly:
 *  - Resource typing comes from Playwright's `request.resourceType()` rather
 *    than CDP's `type`. The values differ in spelling ('xhr' vs 'XHR'); the
 *    filter normalizes.
 *  - Response bodies come from `response.body()`, which can reject for a
 *    redirect, a served-from-cache entry, or a request the page cancelled.
 *    Those are skipped rather than reported as empty, because an empty body
 *    recorded as data is worse than a gap.
 *  - WebSocket frames arrive through Playwright's `websocket` event, which CDP
 *    also needed a separate path for. Both engines expose it.
 *
 * The capture *decision* is shared with the CDP path — see
 * [capture-filter.ts](./capture-filter.ts) — so "no traffic of this kind" means
 * the same thing whichever engine ran.
 *
 * @module browser/driver/traffic-capture
 */

import { DEBUG } from '@interceptor/shared';
import { evaluateInMainWorld, type MainWorldPage } from '../shared/main-world.js';
import { captureDecision, header, isEngineInternal, parseBody } from './capture-filter.js';
import {
	DRAIN_SOURCE,
	type EgressEvent,
	INSTRUMENT_SOURCE,
	UNINSTALL_SOURCE,
} from './instrument.js';
import type { DriverPage, NetworkCaptureCallback } from './types.js';

/** Playwright's request surface, structurally — avoids binding to one engine's types. */
interface PwRequest {
	url(): string;
	method(): string;
	resourceType(): string;
	postData(): string | null;
	allHeaders?(): Promise<Record<string, string>>;
	headers(): Record<string, string>;
}

/** Playwright's response surface, structurally. */
interface PwResponse {
	url(): string;
	status(): number;
	request(): PwRequest;
	allHeaders?(): Promise<Record<string, string>>;
	headers(): Record<string, string>;
	body(): Promise<Buffer>;
}

/** Playwright's WebSocket surface, structurally. */
interface PwWebSocket {
	url(): string;
	on(event: string, handler: (payload: string | Buffer) => void): void;
}

async function headersOf(target: PwRequest | PwResponse): Promise<Record<string, string>> {
	// allHeaders() resolves the real wire headers; headers() is the pre-flight
	// snapshot. Prefer the former, fall back where an engine lacks it.
	try {
		if (target.allHeaders) return await target.allHeaders();
	} catch {
		/* fall through to the snapshot */
	}
	return target.headers();
}

/**
 * Begin capturing traffic from a page. Returns a stop function.
 *
 * Capture is best-effort per response: one body that cannot be read never stops
 * the stream, because a single unreadable response should not end capture for
 * the page.
 */
export function startTrafficCapture(
	page: DriverPage,
	onCapture: NetworkCaptureCallback,
): () => void {
	let stopped = false;

	const onResponse = async (response: PwResponse) => {
		if (stopped) return;
		try {
			const request = response.request();
			const url = response.url();
			const responseHeaders = await headersOf(response);
			const contentType = header(responseHeaders, 'content-type');

			const resourceType = request.resourceType().toLowerCase();

			// Checked before the document path, which deliberately bypasses the data
			// filter — without this, the engine's own injection URLs arrive as site
			// documents and land in a manifest describing the target.
			if (isEngineInternal(url)) {
				DEBUG('traffic-capture', `skip ${url.slice(0, 60)} — engine internal`);
				return;
			}

			// A document is captured on its own path, with its own marker, because
			// pre-hydration HTML is a distinct kind of evidence: it is where
			// server-rendered data lives, and the data filter deliberately drops
			// markup on the XHR path (an HTML body arriving there is an error page
			// or a challenge, not a result). Both facts are true, so documents need
			// a route around the filter rather than a hole in it.
			if (resourceType === 'document') {
				let html: string;
				try {
					html = (await response.body()).toString('utf8');
				} catch (err) {
					// A navigation response body is not always readable after the fact —
					// a redirect, a cache hit, or a document already discarded. Say so,
					// because a document that vanishes without a word looks exactly like
					// a page that was never fetched.
					DEBUG(
						'traffic-capture',
						`document body unavailable for ${url.slice(0, 60)}: ${String(err).slice(0, 60)}`,
					);
					return;
				}
				onCapture(
					{ method: 'DOCUMENT', url, headers: {}, body: null },
					{ url, status: response.status(), headers: { 'content-type': 'text/html' }, body: html },
				);
				return;
			}

			const decision = captureDecision({
				url,
				resourceType,
				contentType,
			});
			if (!decision.capture) {
				DEBUG('traffic-capture', `skip ${url.slice(0, 80)} — ${decision.reason}`);
				return;
			}

			// Rejects for redirects, cache hits, and cancelled requests. A gap is
			// honest; an empty body recorded as data is not.
			let bodyText: string;
			try {
				bodyText = (await response.body()).toString('utf8');
			} catch (err) {
				DEBUG('traffic-capture', `body unavailable for ${url.slice(0, 80)}: ${String(err)}`);
				return;
			}

			onCapture(
				{
					method: request.method(),
					url: request.url(),
					headers: await headersOf(request),
					body: parseBody(request.postData()),
				},
				{
					url,
					status: response.status(),
					headers: responseHeaders,
					body: parseBody(bodyText),
				},
			);
		} catch (err) {
			DEBUG('traffic-capture', `response handler error: ${String(err)}`);
		}
	};

	const onWebSocket = (ws: PwWebSocket) => {
		if (stopped) return;
		const url = ws.url();
		onCapture(
			{ method: 'WS', url, headers: {}, body: null },
			{ url, status: 101, headers: {}, body: { type: 'websocket-created', wsUrl: url } },
		);

		const frame = (direction: 'received' | 'sent') => (payload: string | Buffer) => {
			if (stopped) return;
			const text = typeof payload === 'string' ? payload : payload.toString('utf8');
			onCapture(
				{ method: 'WS-FRAME', url, headers: {}, body: null },
				{
					url,
					status: 0,
					headers: {},
					body: {
						type: 'websocket-frame',
						direction,
						data: parseBody(text),
						size: text.length,
					},
				},
			);
		};
		ws.on('framereceived', frame('received'));
		ws.on('framesent', frame('sent'));
	};

	// Listen at the context rather than the page when the engine offers one.
	// A page listener sees only what the page's own frames requested — not a
	// worker's fetches, not a popup's. That gap is not academic: a site that
	// fetches media segments from a worker shows zero media traffic here while
	// the video plays, and the elimination table then reports adaptive media
	// absent on a page that is visibly streaming.
	// biome-ignore lint/suspicious/noExplicitAny: context() is engine-level
	const p = page as any;
	let target: { on(event: string, handler: (...args: never[]) => void): void } = page;
	try {
		const context = typeof p.context === 'function' ? p.context() : null;
		if (context && typeof context.on === 'function') target = context;
	} catch (err) {
		DEBUG('traffic-capture', `context unavailable, falling back to page: ${String(err)}`);
	}

	target.on('response', onResponse as never);
	target.on('websocket', onWebSocket as never);

	return () => {
		stopped = true;
	};
}

/**
 * Install the egress instrument so it runs before any page script, in every
 * frame, on every navigation.
 *
 * `addInitScript` is what makes this work at all: patching after load loses
 * every call a bundle made while starting up, and startup is exactly when a
 * page opens its sockets and fetches its first payloads. Installing per
 * navigation rather than once per page matters for the same reason — a
 * client-side route change that remounts the app re-runs that startup.
 *
 * Both install paths must reach the page's own JavaScript world. `addInitScript`
 * does. `page.evaluate` does not — it runs in an isolated world that shares the
 * DOM and nothing else, so patching `fetch` there produces a wrapper the page
 * will never call, and capture comes back empty with nothing thrown. The
 * catch-up install therefore goes through the main-world bridge, which is the
 * same trap `main-world.ts` exists to document.
 *
 * Best-effort by design. An engine that rejects init scripts still gets wire
 * capture, and degraded capture beats a session that refuses to start.
 */
export async function installEgressInstrument(page: DriverPage): Promise<boolean> {
	// biome-ignore lint/suspicious/noExplicitAny: addInitScript is engine-level, not on the structural page type
	const p = page as any;
	let installed = false;

	try {
		await p.addInitScript?.(INSTRUMENT_SOURCE);
		installed = true;
	} catch (err) {
		DEBUG('traffic-capture', `addInitScript unavailable: ${String(err).slice(0, 80)}`);
	}

	// The current document loaded before the init hook existed, so patch it too.
	// The instrument is idempotent, which is what makes running both safe.
	try {
		await evaluateInMainWorld(
			p as MainWorldPage,
			(src: string) => {
				// Evaluated inside the injected tag, so this already *is* the page's
				// world; the indirection just executes the source there.
				new Function(src)();
				return true;
			},
			INSTRUMENT_SOURCE,
		);
		installed = true;
	} catch (err) {
		DEBUG('traffic-capture', `catch-up install skipped: ${String(err).slice(0, 80)}`);
	}

	return installed;
}

/**
 * Drain buffered egress events from every frame.
 *
 * This reads a global the instrument wrote, so it must run in the same world
 * that wrote it. An isolated-world `evaluate` has its own `globalThis` and
 * would find nothing — returning an empty array that reads as "the page made no
 * calls" rather than as a failed read. That is the quiet failure this whole
 * module is meant to remove, so the drain goes through the bridge too.
 *
 * Frames are drained individually because an iframe has its own global, and an
 * embedded player or checkout widget is exactly where a transport hides.
 */
export async function drainEgressEvents(page: DriverPage): Promise<EgressEvent[]> {
	// biome-ignore lint/suspicious/noExplicitAny: frames() is engine-level
	const p = page as any;
	const out: EgressEvent[] = [];
	const targets: unknown[] = typeof p.frames === 'function' ? p.frames() : [page];

	for (const frame of targets.length ? targets : [page]) {
		try {
			// An ordinary evaluate: the drain source talks to the page's world over
			// a DOM event rather than by injecting a script, so this survives a
			// `script-src` policy that would refuse the main-world bridge.
			// biome-ignore lint/suspicious/noExplicitAny: structural frame
			const events = (await (frame as any).evaluate(DRAIN_SOURCE)) as EgressEvent[];
			if (Array.isArray(events)) out.push(...events);
		} catch (err) {
			// A detached or cross-origin frame that refuses evaluation is a gap, not
			// a failure; the frames that did answer are still worth reporting.
			DEBUG('traffic-capture', `frame drain skipped: ${String(err).slice(0, 80)}`);
		}
	}
	return out;
}

/**
 * Hand the page back unmodified.
 *
 * Every discovery aid is detectable by construction: a patched global, an
 * unexplained property on `window`, an attribute that appears and vanishes. That
 * is a fair trade while learning what a site has and a bad one afterwards,
 * because the session that collects the data should carry no evidence that
 * anything was instrumented. Removing the aids also removes them as a suspect —
 * a block after this point is about the site or the traffic pattern, not about
 * the observation.
 *
 * Reports per frame rather than throwing: a frame that refuses restoration is
 * still carrying patches, and a caller planning a clean pass needs to know that
 * rather than assume it.
 */
export async function removeEgressInstrument(page: DriverPage): Promise<{
	clean: boolean;
	framesRestored: number;
	framesUnreachable: number;
	detail: string;
}> {
	// biome-ignore lint/suspicious/noExplicitAny: frames() is engine-level
	const p = page as any;
	const targets: unknown[] = typeof p.frames === 'function' ? p.frames() : [page];
	let framesRestored = 0;
	let framesUnreachable = 0;

	for (const frame of targets.length ? targets : [page]) {
		try {
			// biome-ignore lint/suspicious/noExplicitAny: structural frame
			const gone = await (frame as any).evaluate(UNINSTALL_SOURCE);
			if (gone) framesRestored += 1;
			else framesUnreachable += 1;
		} catch (err) {
			// A cross-origin frame refuses evaluation, so restoration cannot be
			// confirmed there. That is not the same as a refusal to restore, and
			// reporting it as one would make every page carrying a third-party
			// iframe permanently un-cleanable — the gate would then always fail and
			// would soon be waived, which is worse than not having it.
			framesUnreachable += 1;
			DEBUG('traffic-capture', `frame unreachable for uninstall: ${String(err).slice(0, 80)}`);
		}
	}

	// The main frame is the one that matters: it is where the page's own code
	// runs and where an aid would be observed. An unreachable third-party frame
	// is worth reporting and not worth blocking on.
	const clean = framesRestored > 0;
	const detail = framesUnreachable
		? `${framesRestored} frame(s) restored; ${framesUnreachable} could not be reached to confirm ` +
			'(cross-origin frames refuse evaluation, so an init-script patch there cannot be verified either way).'
		: `${framesRestored} frame(s) restored.`;

	return { clean, framesRestored, framesUnreachable, detail };
}
