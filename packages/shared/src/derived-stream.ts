/**
 * A live stream derived from a source that does not have one.
 *
 * MOTIVATION
 *   Two streaming shapes already exist in this repo and both consume a stream
 *   that the upstream already publishes: one reads an upstream SSE endpoint,
 *   one bridges an upstream WebSocket to SSE. Neither helps with the ordinary
 *   case, which is a server-rendered page that publishes nothing at all and
 *   simply differs from what it said a minute ago.
 *
 *   This module covers that case. It polls, compares against what it has
 *   already seen, and emits only the arrivals — so a caller subscribes once
 *   rather than re-fetching a list and diffing it themselves.
 *
 *   THE STREAM IS DERIVED, NOT INTERCEPTED. Nothing here is evidence that the
 *   upstream has a realtime transport, and a transport elimination table must
 *   not be softened because a route like this exists. The site is still
 *   answering one request at a time with a whole page; the liveness is ours.
 *
 * IDENTITY, NEVER POSITION
 *   The diff keys on an item's intrinsic id. A ranked list reorders between
 *   polls — that is what ranked lists do — so a positional key reports every
 *   shuffled item as new and misses a genuine arrival that lands mid-list.
 *
 * SILENCE IS AMBIGUOUS, SO IT IS NARRATED
 *   "Connected, nothing new" and "dead" look identical on a quiet channel, and
 *   so does "opened but never actually polled". Every run therefore emits an
 *   `open` event naming the upstream and the interval, a `baseline` event when
 *   the first poll establishes what was already there, a `heartbeat` carrying
 *   the poll count, an `error` event when a poll fails, and an `end` naming the
 *   reason. A caller can always tell which of those it is looking at.
 *
 *   `baseline` deliberately does not emit the first poll's items as arrivals.
 *   An `item` event means "this appeared while you were connected", and
 *   flooding the connection with a snapshot at t=0 would make that claim false
 *   for the entire first page.
 *
 * BOUNDS
 *   Every run is bounded by `maxLifetimeMs` (hard deadline, default 60s) and
 *   by the client's connection: the loop stops on abort and issues no further
 *   upstream request. Polling never runs faster than `intervalMs` (default
 *   20s, floor 5s). At most `maxSeenIds` identifiers are remembered (default
 *   2000, oldest dropped) so a long run cannot grow without limit. On an
 *   upstream rate limit the run stops rather than backing off and trying
 *   again: a limit we caused is not a property of the target, and a retry loop
 *   is the one behaviour that could turn one refusal into many. No model
 *   calls, no disk writes.
 *
 * Importing this module runs nothing. `diffNewItems` is pure and is where the
 * behaviour that matters lives, so it is tested over fixtures with no network.
 *
 * @module shared/derived-stream
 */

import { DEBUG } from './debug.js';

// ─── Bounds ──────────────────────────────────────────────────────────

export const DERIVED_STREAM_LIMITS = {
	/** Nothing polls faster than this, whatever the caller asks for. */
	minIntervalMs: 5_000,
	defaultIntervalMs: 20_000,
	defaultLifetimeMs: 60_000,
	maxLifetimeMs: 300_000,
	defaultHeartbeatMs: 15_000,
	maxSeenIds: 2_000,
} as const;

// ─── Pure diff ───────────────────────────────────────────────────────

/**
 * The items whose identity has not been seen before, in upstream order.
 *
 * Mutates `seen` — it is the caller's running memory, not a value — and
 * returns only the arrivals. An item with an empty identity is dropped rather
 * than treated as new every poll: an identifier the source did not supply
 * cannot be compared, and emitting it repeatedly is worse than omitting it.
 */
export function diffNewItems<T>(
	seen: Set<string>,
	items: readonly T[],
	identify: (item: T) => string,
	maxSeenIds: number = DERIVED_STREAM_LIMITS.maxSeenIds,
): { fresh: T[]; unidentified: number } {
	const fresh: T[] = [];
	let unidentified = 0;
	for (const item of items) {
		const id = identify(item);
		if (!id) {
			unidentified += 1;
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		fresh.push(item);
	}
	// A Set iterates in insertion order, so the oldest identifiers are the ones
	// dropped when the memory is full.
	if (seen.size > maxSeenIds) {
		const excess = seen.size - maxSeenIds;
		let dropped = 0;
		for (const id of seen) {
			if (dropped >= excess) break;
			seen.delete(id);
			dropped += 1;
		}
	}
	return { fresh, unidentified };
}

// ─── Stream ──────────────────────────────────────────────────────────

export interface DerivedStreamOptions<T> {
	/**
	 * What is being polled, in the opening event. A caller reading the stream
	 * should be able to see that this is derived from a page rather than
	 * received from a feed.
	 */
	upstream: string;
	/** One poll. Returns the current list; ordering is not relied upon. */
	poll: () => Promise<readonly T[]>;
	/** Intrinsic identity. Never an index. */
	identify: (item: T) => string;
	/** Optional projection applied to each emitted item. */
	project?: (item: T) => unknown;
	intervalMs?: number;
	lifetimeMs?: number;
	heartbeatMs?: number;
	/** Ends the run when the client disconnects. */
	signal?: AbortSignal;
	/** Names the emitting domain in debug output. */
	label?: string;
}

/** A poll failure carrying the upstream status, so 429 can be told apart. */
export class UpstreamStatusError extends Error {
	constructor(
		readonly status: number,
		message?: string,
	) {
		super(message ?? `upstream returned ${status}`);
		this.name = 'UpstreamStatusError';
	}
}

/**
 * Poll `poll`, diff by `identify`, and emit SSE frames.
 *
 * Returns the body for a `text/event-stream` response. The first poll runs
 * immediately rather than after one interval — a stream whose first sign of
 * life is 20 seconds away is indistinguishable from one that never started.
 */
export function derivedItemStream<T>(options: DerivedStreamOptions<T>): ReadableStream<Uint8Array> {
	const intervalMs = Math.max(
		DERIVED_STREAM_LIMITS.minIntervalMs,
		options.intervalMs ?? DERIVED_STREAM_LIMITS.defaultIntervalMs,
	);
	const lifetimeMs = Math.min(
		DERIVED_STREAM_LIMITS.maxLifetimeMs,
		options.lifetimeMs ?? DERIVED_STREAM_LIMITS.defaultLifetimeMs,
	);
	const heartbeatMs = options.heartbeatMs ?? DERIVED_STREAM_LIMITS.defaultHeartbeatMs;
	const label = options.label ?? 'derived-stream';
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const seen = new Set<string>();
			let live = true;
			let polls = 0;
			let emitted = 0;
			let pollTimer: ReturnType<typeof setTimeout> | undefined;
			let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
			let deadline: ReturnType<typeof setTimeout> | undefined;

			const send = (event: string, data: unknown) => {
				if (!live) return;
				controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
			};

			const finish = (reason: string) => {
				if (!live) return;
				send('end', { reason, polls, emitted });
				live = false;
				if (pollTimer) clearTimeout(pollTimer);
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				if (deadline) clearTimeout(deadline);
				options.signal?.removeEventListener('abort', onAbort);
				try {
					controller.close();
				} catch {
					// Already closed by the client going away first.
				}
				DEBUG(label, `stream ended: ${reason} (polls=${polls}, emitted=${emitted})`);
			};

			function onAbort() {
				// The client is gone. Stopping here is the point of holding the
				// signal at all: a stream nobody reads must not keep asking the
				// upstream for pages.
				finish('client disconnected');
			}

			const runPoll = async () => {
				if (!live) return;
				let items: readonly T[];
				try {
					items = await options.poll();
				} catch (err) {
					if (err instanceof UpstreamStatusError && err.status === 429) {
						// Said in-band and then stopped. Retrying into a limit deepens a
						// footprint that is ours rather than the site's.
						send('error', {
							status: 429,
							action: 'stopped',
							detail: 'upstream rate limit — not retried',
						});
						finish('upstream rate limit');
						return;
					}
					send('error', {
						status: err instanceof UpstreamStatusError ? err.status : null,
						action: 'continuing',
						detail: String(err).slice(0, 200),
					});
					// A single bad poll is not the end of the source, so the loop
					// continues — but the caller was told, rather than seeing a gap it
					// would have read as "nothing new".
					if (live) pollTimer = setTimeout(runPoll, intervalMs);
					return;
				}

				polls += 1;
				const { fresh, unidentified } = diffNewItems(seen, items, options.identify);
				if (polls === 1) {
					send('baseline', {
						count: items.length,
						unidentified,
						detail: 'items already present when you connected; not emitted as arrivals',
					});
				} else {
					for (const item of fresh) {
						emitted += 1;
						send('item', options.project ? options.project(item) : item);
					}
				}
				if (live) pollTimer = setTimeout(runPoll, intervalMs);
			};

			send('open', {
				upstream: options.upstream,
				intervalMs,
				lifetimeMs,
				derived: true,
				detail:
					'Derived stream: the upstream publishes no realtime transport. This is a poll-and-diff over a page, not an intercepted feed.',
			});

			if (options.signal?.aborted) {
				finish('client disconnected');
				return;
			}
			options.signal?.addEventListener('abort', onAbort);

			deadline = setTimeout(() => finish('lifetime elapsed'), lifetimeMs);
			heartbeatTimer = setInterval(() => {
				send('heartbeat', { polls, emitted, seen: seen.size });
			}, heartbeatMs);

			// Kick the loop immediately. An unhandled rejection here would take the
			// process down rather than the stream, so the catch is the outer bound
			// on everything above.
			void runPoll().catch((err) => {
				send('error', { status: null, action: 'stopped', detail: String(err).slice(0, 200) });
				finish('poll loop failed');
			});
		},
	});
}
