'use client';

/**
 * Hacker News list, built from .snapshots/frame-1-hn/description.md and nothing
 * else. Every layout decision here traces to a numbered section of that file.
 *
 * §8 keeps this a rendering of our route's data in the frame's visual language
 * rather than a copy of the site: no login, no submit, no search, no hide, and
 * only the list types the route actually serves.
 */

import { useCallback, useEffect, useState } from 'react';
import { useUrlParam } from '@/lib/url-state';
import { type Story, StoryRow, StoryRowSkeleton } from './story-row';

/** §8: only the tabs the route serves. `past`/`ask`/`show`/`jobs` have no route. */
const LIST_TYPES = ['top', 'new', 'best'] as const;

/** §6: the loading state holds 30 rows, matching what a page actually returns. */
const SKELETON_KEYS = Array.from({ length: 30 }, (_, i) => `skeleton-${i + 1}`);

type ListResponse = {
	type: string;
	items: Story[];
	returned: number;
	hasMore: boolean;
	nextPage: number | null;
};

type Load =
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ok'; data: ListResponse };

export default function HackerNewsPage() {
	const [type, setType] = useUrlParam('type', 'top');
	const [load, setLoad] = useState<Load>({ status: 'loading' });

	const fetchList = useCallback(async (listType: string, signal: AbortSignal) => {
		setLoad({ status: 'loading' });
		try {
			const res = await fetch(`/api/hackernews/list/${listType}`, { signal });
			if (!res.ok) throw new Error(`The route returned HTTP ${res.status}.`);
			setLoad({ status: 'ok', data: (await res.json()) as ListResponse });
		} catch (err) {
			if (signal.aborted) return;
			setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) });
		}
	}, []);

	useEffect(() => {
		const ac = new AbortController();
		void fetchList(type, ac.signal);
		return () => ac.abort();
	}, [type, fetchList]);

	return (
		// §2: one centered column. §7: full width at the narrow viewport, ~85% above
		// it — a real breakpoint, not one unconditional width.
		<div className="mx-auto w-full min-w-0 rounded-md border bg-card text-[13px] md:w-[85%]">
			{/* §2/§3: a full-width header band; the wordmark is the only bold text.
			    §8: the band's shape carries over from the frame, its orange does not. */}
			<header className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-t-md border-b bg-muted px-3 py-2 leading-[15px]">
				<span className="font-semibold text-foreground">Hacker News</span>
				<nav className="flex flex-wrap gap-x-3 text-[11px]">
					{LIST_TYPES.map((t) => (
						<button
							key={t}
							type="button"
							onClick={() => void setType(t)}
							className={
								t === type
									? 'text-foreground underline underline-offset-2'
									: 'text-muted-foreground hover:underline'
							}
						>
							{t}
						</button>
					))}
				</nav>
			</header>

			<div className="px-2 py-1">
				{load.status === 'loading' ? (
					// §6: 30 skeleton rows at the populated rhythm, so nothing reflows.
					<ol className="list-none">
						{SKELETON_KEYS.map((k) => (
							<StoryRowSkeleton key={k} />
						))}
					</ol>
				) : null}

				{/* §6: error and empty must be distinguishable — different words, and
				    error names what failed. */}
				{load.status === 'error' ? (
					<p className="py-2 text-[13px] text-destructive">
						Could not load the {type} list. {load.message}
					</p>
				) : null}

				{load.status === 'ok' && load.data.items.length === 0 ? (
					<p className="py-2 text-[13px] text-muted-foreground">
						The {type} list returned no stories.
					</p>
				) : null}

				{load.status === 'ok' && load.data.items.length > 0 ? (
					<>
						<ol className="list-none">
							{load.data.items.map((s) => (
								// §5: keyed by id, never the array index.
								<StoryRow key={s.id} story={s} />
							))}
						</ol>

						{/* §6 Partial: a count that disagrees with `returned` is reported,
						    never silently truncated. */}
						{load.data.returned !== load.data.items.length ? (
							<p className="py-1 text-[11px] text-destructive">
								Showing {load.data.items.length} of {load.data.returned} reported.
							</p>
						) : null}

						{/* §2/§5: the "More" link appears only when hasMore is true. */}
						{load.data.hasMore ? (
							<p className="py-1 pl-[38px] text-[13px]">
								<a
									href={`https://news.ycombinator.com/news?p=${load.data.nextPage ?? 2}`}
									className="text-muted-foreground hover:underline"
								>
									More
								</a>
							</p>
						) : null}
					</>
				) : null}
			</div>

			{/* §2 named a footer of links and a search row; §10 puts both out of scope, so
			    nothing survives the subtraction. Recorded as a §2/§10 contradiction in
			    cycle 1 — the format now requires §10 to be resolved against §2. */}
		</div>
	);
}
