/**
 * Yahoo Finance — the live price stream, subscribed and decoded.
 *
 * The socket is the distinctive transport on this site and the one most likely
 * to be written off. It is public — no cookie, no crumb — and every frame is a
 * JSON envelope whose `message` is base64-wrapped protobuf. A reader expecting
 * JSON sees a socket delivering noise and records it as empty.
 *
 * Two shapes are offered because a stream has two honest consumers. A snapshot
 * collects N frames and returns them, which suits a caller that wants current
 * prices. A subscription holds the connection open and forwards frames as
 * server-sent events, which suits a caller that wants the stream itself. Both
 * are bounded: an unbounded stream route is a socket nobody closes.
 *
 * @module domain-yahoofinance/routes
 */

import type { DomainRoute } from '@interceptor/browser/handler/domain-loader';
import { DEBUG, withCompleteness } from '@interceptor/shared';
import { decodePricing } from './protobuf';

const STREAMER_URL = 'wss://streamer.finance.yahoo.com/?version=2';

/** Hard bounds. A route that can hold a socket open forever will. */
const LIMITS = { maxFrames: 50, maxSeconds: 60, defaultFrames: 5, defaultSeconds: 15 };

function symbolsOf(raw: string | undefined): string[] {
	return String(raw ?? 'AAPL')
		.split(',')
		.map((s) => s.trim().toUpperCase())
		.filter(Boolean)
		.slice(0, 25);
}

export const routes: DomainRoute[] = [
	{
		method: 'GET',
		path: '/stream/snapshot',
		examples: ['/stream/snapshot?symbols=AAPL,TSLA&frames=3'],
		upstream: ['wss://streamer.finance.yahoo.com/'],
		transport: 'WebSocket',
		description: 'Subscribe, collect a bounded number of decoded price frames, close.',
		browserRequired: false,
		handler: async (c) => {
			const url = new URL(c.req.url);
			const symbols = symbolsOf(url.searchParams.get('symbols') ?? undefined);
			const want = Math.min(
				Number(url.searchParams.get('frames') ?? LIMITS.defaultFrames),
				LIMITS.maxFrames,
			);
			const seconds = Math.min(
				Number(url.searchParams.get('seconds') ?? LIMITS.defaultSeconds),
				LIMITS.maxSeconds,
			);

			const { default: WebSocket } = await import('ws');
			const frames: Record<string, unknown>[] = [];

			const collected = await new Promise<Record<string, unknown>[]>((resolve) => {
				const ws = new WebSocket(STREAMER_URL);
				// The deadline resolves rather than rejects: a quiet market is a real
				// answer, and returning nothing with an explanation beats an error that
				// reads like the transport is broken.
				const deadline = setTimeout(() => {
					ws.close();
					resolve(frames);
				}, seconds * 1000);

				ws.on('open', () => {
					DEBUG('yahoofinance', `subscribing to ${symbols.join(',')}`);
					ws.send(JSON.stringify({ subscribe: symbols }));
				});
				ws.on('message', (raw: Buffer) => {
					let envelope: { message?: string };
					try {
						envelope = JSON.parse(raw.toString());
					} catch {
						return; // a non-JSON frame is the server's business, not ours
					}
					if (!envelope.message) return;
					frames.push(decodePricing(Buffer.from(envelope.message, 'base64')));
					if (frames.length >= want) {
						clearTimeout(deadline);
						ws.close();
						resolve(frames);
					}
				});
				ws.on('error', () => {
					clearTimeout(deadline);
					resolve(frames);
				});
				ws.on('close', () => {
					clearTimeout(deadline);
					resolve(frames);
				});
			});

			return c.json(
				withCompleteness({
					symbols,
					frames: collected,
					total: collected.length,
					_note: collected.length
						? 'Frames are base64-wrapped protobuf on a public socket; field names are those observed, unknown fields are reported by number.'
						: 'Subscribed successfully but no frame arrived inside the window — markets may be closed for these symbols. Not a failure of the transport.',
				}),
			);
		},
	},
	{
		method: 'GET',
		path: '/stream/subscribe',
		examples: ['/stream/subscribe?symbols=AAPL&seconds=8'],
		upstream: ['wss://streamer.finance.yahoo.com/'],
		transport: 'SSE',
		description: 'Hold the socket open and forward decoded frames as server-sent events.',
		browserRequired: false,
		handler: async (c) => {
			const url = new URL(c.req.url);
			const symbols = symbolsOf(url.searchParams.get('symbols') ?? undefined);
			const seconds = Math.min(
				Number(url.searchParams.get('seconds') ?? LIMITS.defaultSeconds),
				LIMITS.maxSeconds,
			);

			const { default: WebSocket } = await import('ws');
			const encoder = new TextEncoder();

			// A socket in, an event stream out — the subscription shape, so a caller
			// consumes it as it arrives instead of waiting for a batch.
			const body = new ReadableStream({
				start(controller) {
					const ws = new WebSocket(STREAMER_URL);
					let open = true;
					const send = (event: string, data: unknown) => {
						if (!open) return;
						controller.enqueue(
							encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
						);
					};
					const finish = (reason: string) => {
						if (!open) return;
						send('end', { reason });
						open = false;
						try {
							ws.close();
						} catch {
							/* already closing */
						}
						controller.close();
					};

					const deadline = setTimeout(() => finish('window elapsed'), seconds * 1000);
					ws.on('open', () => {
						// Announcing the subscription to the caller is not making it. The
						// server sends nothing until asked, so without this the stream
						// opens, stays silent, and closes on its deadline — a plausible
						// empty result that looks like a quiet market.
						ws.send(JSON.stringify({ subscribe: symbols }));
						send('open', { symbols });
					});
					ws.on('message', (raw: Buffer) => {
						try {
							const envelope = JSON.parse(raw.toString()) as { message?: string };
							if (envelope.message) {
								send('pricing', decodePricing(Buffer.from(envelope.message, 'base64')));
							}
						} catch {
							/* ignore a frame we cannot parse rather than ending the stream */
						}
					});
					ws.on('error', (err: Error) => {
						clearTimeout(deadline);
						finish(`socket error: ${String(err).slice(0, 80)}`);
					});
					ws.on('close', () => {
						clearTimeout(deadline);
						finish('upstream closed');
					});
				},
			});

			return new Response(body, {
				headers: {
					'content-type': 'text/event-stream',
					'cache-control': 'no-cache',
					connection: 'keep-alive',
				},
			});
		},
	},
];
