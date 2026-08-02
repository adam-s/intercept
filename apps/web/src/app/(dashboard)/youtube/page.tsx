'use client';

/**
 * Video search: a query-driven screen whose results are heterogeneous.
 *
 * Two things make this screen different from the other domain screens, and both
 * are load-bearing.
 *
 * It has a state the others do not: **nothing asked yet**. That is not the empty
 * state — empty means a query ran and matched nothing, which is a fact about the
 * query. Rendering the two the same way tells a reader their search failed when
 * they have not searched.
 *
 * And the search block does not scroll away. The query is the subject of the
 * screen, so it stays readable at any scroll depth. It sticks inside the shell's
 * scrolling main region rather than owning a scroll of its own, because nesting
 * one scrolling region inside another leaves a reader with two scrollbars and no
 * way to guess which one moves.
 */

import { useEffect, useRef, useState } from 'react';
import { Completeness, NotAsked, NothingMatched, RouteFailed } from '@/components/domain/states';
import { useUrlParam } from '@/lib/url-state';
import { useRouteData } from '@/lib/use-route-data';
import { type Result, ResultRow, ResultRowSkeleton } from './result-row';

type SearchResponse = {
	query: string;
	videos: Result[];
	returned: number;
	indicatedTotal: number | null;
	hasMore: boolean;
};

/** Loading shows the populated rhythm; four rows is about one screenful. */
const SKELETON_KEYS = ['s1', 's2', 's3', 's4'];

export default function YouTubePage() {
	const [query, setQuery] = useUrlParam('q', '');
	const [draft, setDraft] = useState(query);
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [suggestOpen, setSuggestOpen] = useState(false);
	const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// `null` is the not-yet-asked state, which this screen has and the others do
	// not. It is not the empty state: empty is a fact about a query that ran.
	const load = useRouteData<SearchResponse>(
		query ? `/api/youtube/search?q=${encodeURIComponent(query)}` : null,
	);

	useEffect(() => {
		setDraft(query);
	}, [query]);

	// The suggestion list is the one control here whose options come from
	// upstream. It follows the text in the field, not the query that ran.
	useEffect(() => {
		const term = draft.trim();
		if (!suggestOpen || term.length < 2) {
			setSuggestions([]);
			return;
		}
		const ac = new AbortController();
		const timer = setTimeout(() => {
			void fetch(`/api/youtube/suggest?q=${encodeURIComponent(term)}`, { signal: ac.signal })
				.then((r) => (r.ok ? r.json() : { suggestions: [] }))
				.then((j) =>
					setSuggestions(((j as { suggestions?: string[] }).suggestions ?? []).slice(0, 8)),
				)
				// A suggestion list that cannot load is not worth an error: the field
				// still works, so it closes quietly.
				.catch(() => setSuggestions([]));
		}, 200);
		return () => {
			clearTimeout(timer);
			ac.abort();
		};
	}, [draft, suggestOpen]);

	const submit = (value: string) => {
		const next = value.trim();
		setSuggestOpen(false);
		setSuggestions([]);
		void setQuery(next);
	};

	return (
		<div className="mx-auto flex w-full min-w-0 flex-col">
			{/* Sticky, not fixed: it stops at the top of the shell's scroll region.
			    The negative inset and matching padding let the background reach the
			    shell's own padding, so results do not show through beside it. */}
			<div className="sticky top-0 z-20 -mx-4 -mt-4 mb-5 border-b bg-background px-4 pt-4 pb-3 md:-mx-6 md:-mt-6 md:px-6 md:pt-6">
				<form
					className="relative mx-auto flex w-full max-w-3xl"
					onSubmit={(e) => {
						e.preventDefault();
						submit(draft);
					}}
				>
					<input
						value={draft}
						onChange={(e) => {
							setDraft(e.target.value);
							setSuggestOpen(true);
						}}
						onFocus={() => setSuggestOpen(true)}
						onBlur={() => {
							// Deferred: a click on a suggestion blurs the field first, and
							// closing immediately would remove the row being clicked.
							if (blurTimer.current) clearTimeout(blurTimer.current);
							blurTimer.current = setTimeout(() => setSuggestOpen(false), 120);
						}}
						placeholder="Search videos"
						aria-label="Search videos"
						autoComplete="off"
						className="h-10 min-w-0 flex-1 rounded-l-md border border-r-0 bg-background px-3 text-[14px] outline-none focus:border-ring"
					/>
					<button
						type="submit"
						className="h-10 shrink-0 rounded-r-md border bg-muted px-4 text-[14px] font-medium hover:bg-muted/70"
					>
						Search
					</button>
					{query ? (
						<button
							type="button"
							onClick={() => {
								setDraft('');
								submit('');
							}}
							className="ml-2 h-10 shrink-0 rounded-md px-2 text-[13px] text-muted-foreground hover:underline"
						>
							Clear
						</button>
					) : null}

					{/* Overlays what is below it rather than pushing the results down. */}
					{suggestOpen && suggestions.length > 0 ? (
						<ul className="absolute top-11 left-0 z-30 w-full overflow-hidden rounded-md border bg-background shadow-md">
							{suggestions.map((s) => (
								<li key={s}>
									<button
										type="button"
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => {
											setDraft(s);
											submit(s);
										}}
										className="block w-full px-3 py-1.5 text-left text-[13px] hover:bg-muted"
									>
										{s}
									</button>
								</li>
							))}
						</ul>
					) : null}
				</form>

				{/* One place decides how a shortfall is worded, for every screen. */}
				{load.status === 'ok' ? (
					<div className="mx-auto mt-2 w-full max-w-3xl">
						<Completeness
							shown={load.data.videos.length}
							returned={load.data.returned}
							indicatedTotal={load.data.indicatedTotal}
							hasMore={load.data.hasMore}
							noun="video"
						/>
					</div>
				) : null}
			</div>

			<div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
				{/* Nothing asked yet — distinct from empty, which is a fact about a
				    query that ran. */}
				{load.status === 'idle' ? (
					<NotAsked>Search to see results. Nothing has been requested yet.</NotAsked>
				) : null}

				{load.status === 'loading' ? SKELETON_KEYS.map((k) => <ResultRowSkeleton key={k} />) : null}

				{load.status === 'error' ? (
					<RouteFailed what={`results for “${query}”`} message={load.message} />
				) : null}

				{load.status === 'ok' && load.data.videos.length === 0 ? (
					<NothingMatched>
						Nothing matched “{load.data.query}”. Try a different phrase.
					</NothingMatched>
				) : null}

				{load.status === 'ok'
					? load.data.videos.map((v) => (
							// Keyed by id, never the array index.
							<ResultRow key={v.videoId} result={v} />
						))
					: null}
			</div>
		</div>
	);
}
