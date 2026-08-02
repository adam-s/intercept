import { describe, expect, it } from 'vitest';
import { derivedItemStream, diffNewItems, UpstreamStatusError } from './derived-stream.js';

interface Row {
	id: string;
	rank: number;
}

/** Read an SSE body to completion and return the parsed frames. */
async function drain(
	stream: ReadableStream<Uint8Array>,
): Promise<Array<{ event: string; data: unknown }>> {
	const text = await new Response(stream).text();
	return text
		.split('\n\n')
		.filter(Boolean)
		.map((frame) => {
			const event = frame.match(/^event:\s*(\S+)/m)?.[1] ?? '';
			const data = frame.match(/^data:\s*(.+)$/m)?.[1] ?? 'null';
			return { event, data: JSON.parse(data) };
		});
}

describe('diffNewItems', () => {
	const id = (r: Row) => r.id;

	it('reports every item on first sight and nothing on a repeat', () => {
		const seen = new Set<string>();
		const page: Row[] = [
			{ id: 'a', rank: 1 },
			{ id: 'b', rank: 2 },
		];
		expect(diffNewItems(seen, page, id).fresh.map(id)).toEqual(['a', 'b']);
		expect(diffNewItems(seen, page, id).fresh).toEqual([]);
	});

	it('is unmoved by reordering — the failure a positional key would produce', () => {
		const seen = new Set<string>();
		diffNewItems(
			seen,
			[
				{ id: 'a', rank: 1 },
				{ id: 'b', rank: 2 },
				{ id: 'c', rank: 3 },
			],
			id,
		);
		// Same three stories, ranked differently, plus one genuine arrival that
		// lands mid-list rather than at the head.
		const shuffled: Row[] = [
			{ id: 'c', rank: 1 },
			{ id: 'd', rank: 2 },
			{ id: 'a', rank: 3 },
			{ id: 'b', rank: 4 },
		];
		expect(diffNewItems(seen, shuffled, id).fresh.map(id)).toEqual(['d']);
	});

	it('drops items whose identity is missing rather than re-emitting them', () => {
		const seen = new Set<string>();
		const page: Row[] = [
			{ id: '', rank: 1 },
			{ id: 'a', rank: 2 },
		];
		expect(diffNewItems(seen, page, id).fresh.map(id)).toEqual(['a']);
		expect(diffNewItems(seen, page, id)).toEqual({ fresh: [], unidentified: 1 });
	});

	it('forgets the oldest identifiers once memory is full', () => {
		const seen = new Set<string>();
		diffNewItems(
			seen,
			[
				{ id: 'a', rank: 1 },
				{ id: 'b', rank: 2 },
				{ id: 'c', rank: 3 },
			],
			id,
			2,
		);
		expect([...seen]).toEqual(['b', 'c']);
	});
});

describe('derivedItemStream', () => {
	it('polls, announces the baseline, then emits only arrivals', async () => {
		const pages: Row[][] = [
			[
				{ id: 'a', rank: 1 },
				{ id: 'b', rank: 2 },
			],
			[
				{ id: 'c', rank: 1 },
				{ id: 'a', rank: 2 },
				{ id: 'b', rank: 3 },
			],
		];
		let n = 0;
		const frames = await drain(
			derivedItemStream<Row>({
				upstream: 'example.invalid/newest',
				intervalMs: 5_000, // clamped to the floor; two polls inside the window
				lifetimeMs: 6_000,
				heartbeatMs: 60_000,
				poll: async () => pages[Math.min(n++, pages.length - 1)],
				identify: (r) => r.id,
			}),
		);

		const events = frames.map((f) => f.event);
		expect(events[0]).toBe('open');
		expect(events).toContain('baseline');
		expect(events.at(-1)).toBe('end');

		// The first poll's two items are the baseline, not arrivals — only the
		// story that showed up while the caller was connected is an `item`.
		const items = frames.filter((f) => f.event === 'item').map((f) => f.data as Row);
		expect(items.map((r) => r.id)).toEqual(['c']);
	}, 15_000);

	it('says so in-band and stops on a rate limit, rather than polling again', async () => {
		let polls = 0;
		const frames = await drain(
			derivedItemStream<Row>({
				upstream: 'example.invalid/newest',
				intervalMs: 5_000,
				lifetimeMs: 20_000,
				poll: async () => {
					polls += 1;
					throw new UpstreamStatusError(429);
				},
				identify: (r) => r.id,
			}),
		);

		expect(polls).toBe(1);
		const error = frames.find((f) => f.event === 'error');
		expect(error?.data).toMatchObject({ status: 429, action: 'stopped' });
		expect(frames.at(-1)).toMatchObject({ event: 'end' });
		expect((frames.at(-1)?.data as { reason: string }).reason).toBe('upstream rate limit');
	}, 15_000);

	it('reports a failed poll and keeps going, so a gap is never silent', async () => {
		let polls = 0;
		const frames = await drain(
			derivedItemStream<Row>({
				upstream: 'example.invalid/newest',
				intervalMs: 5_000,
				lifetimeMs: 6_000,
				poll: async () => {
					polls += 1;
					if (polls === 1) throw new UpstreamStatusError(503);
					return [{ id: 'a', rank: 1 }];
				},
				identify: (r) => r.id,
			}),
		);

		expect(polls).toBeGreaterThan(1);
		expect(frames.find((f) => f.event === 'error')?.data).toMatchObject({
			status: 503,
			action: 'continuing',
		});
	}, 15_000);

	it('stops polling when the client disconnects', async () => {
		const controller = new AbortController();
		let polls = 0;
		const stream = derivedItemStream<Row>({
			upstream: 'example.invalid/newest',
			intervalMs: 5_000,
			lifetimeMs: 60_000,
			poll: async () => {
				polls += 1;
				return [];
			},
			identify: (r) => r.id,
			signal: controller.signal,
		});
		const drained = drain(stream);
		await new Promise((r) => setTimeout(r, 300));
		controller.abort();
		const frames = await drained;

		const pollsAtAbort = polls;
		await new Promise((r) => setTimeout(r, 6_000));
		expect(polls).toBe(pollsAtAbort);
		expect((frames.at(-1)?.data as { reason: string }).reason).toBe('client disconnected');
	}, 20_000);
});
