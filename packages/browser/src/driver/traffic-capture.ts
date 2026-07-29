/**
 * Protocol-Agnostic Traffic Capture
 *
 * Traffic capture is this framework's core feature, and it was built on CDP
 * `Network.*` events — which is Chromium-only. This module rebuilds it on
 * Playwright's own `request`/`response` events, which every engine supports,
 * so capture is no longer the thing that pins the framework to one browser.
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
import { captureDecision, header, parseBody } from './capture-filter.js';
import { DRAIN_SOURCE, type EgressEvent, INSTRUMENT_SOURCE } from './instrument.js';
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

			const decision = captureDecision({
				url,
				resourceType: request.resourceType().toLowerCase(),
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

	page.on('response', onResponse as never);
	page.on('websocket', onWebSocket as never);

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
			const events = await evaluateInMainWorld<EgressEvent[], string>(
				frame as MainWorldPage,
				(src: string) => new Function(`return ${src}`)() as EgressEvent[],
				DRAIN_SOURCE,
			);
			if (Array.isArray(events)) out.push(...events);
		} catch (err) {
			// A detached or cross-origin frame that refuses evaluation is a gap, not
			// a failure; the frames that did answer are still worth reporting.
			DEBUG('traffic-capture', `frame drain skipped: ${String(err).slice(0, 80)}`);
		}
	}
	return out;
}
