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
import { captureDecision, header, parseBody } from './capture-filter.js';
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
