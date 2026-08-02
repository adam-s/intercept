'use client';

/**
 * Hacker News list: one dense ranked column.
 *
 * This renders our route's data in the source's visual language rather than
 * copying the site. Anything the route cannot serve is cut rather than mocked —
 * no login, no submit, no search, no hide — because a control that cannot act is
 * worse than no control, and only the list types the route actually serves get a
 * tab.
 */

import { useCallback, useEffect, useState } from 'react';
import { useUrlParam } from '@/lib/url-state';
import { type Story, StoryRow, StoryRowSkeleton } from './story-row';

/** Only the tabs the route serves. `past`/`ask`/`show`/`jobs` have no route. */
const LIST_TYPES = ['top', 'new', 'best'] as const;

/** Loading holds 30 rows, matching what a page returns, so nothing reflows. */
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
		// One centered column: full width at the narrow viewport, ~85% above it. A
		// real breakpoint, because one unconditional width satisfies the wide
		// reading of the rule and silently fails the narrow one.
		<div className="mx-auto w-full min-w-0 rounded-md border bg-card text-[13px] md:w-[85%]">
			{/* A full-width header band; the wordmark is the only bold text. The
			    band's shape carries over from the source, its brand hue does not. */}
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
					// 30 skeleton rows at the populated rhythm, so nothing reflows.
					<ol className="list-none">
						{SKELETON_KEYS.map((k) => (
							<StoryRowSkeleton key={k} />
						))}
					</ol>
				) : null}

				{/* Error and empty are different facts, so they get different words —
				    and the error names what failed, because a refusal a reader takes
				    for an empty list is a refusal nobody retries. */}
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
								// Keyed by id, never the array index: the list reorders.
								<StoryRow key={s.id} story={s} />
							))}
						</ol>

						{/* A count that disagrees with `returned` is reported. Rendering N
						    rows silently is indistinguishable from a source holding N. */}
						{load.data.returned !== load.data.items.length ? (
							<p className="py-1 text-[11px] text-destructive">
								Showing {load.data.items.length} of {load.data.returned} reported.
							</p>
						) : null}

						{/* "More" appears only when the route says more exists. */}
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

			{/* The source's footer links and search row are both out of scope — every
			    one needs a route this domain does not expose — so nothing survives
			    the subtraction and no empty footer is rendered in their place. */}
		</div>
	);
}
