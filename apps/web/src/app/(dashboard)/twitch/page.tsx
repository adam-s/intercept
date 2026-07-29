'use client';

/**
 * A category of live streams, built from
 * .snapshots/frame-twitch/description.md and nothing else.
 *
 * §7: the source's left rail and top bar duplicate the app shell, so they are
 * cut rather than stacked.
 */

import { useCallback, useEffect, useState } from 'react';
import { useUrlParam } from '@/lib/url-state';
import { type Stream, StreamCard, StreamCardSkeleton } from './stream-card';

/** §3: two rows of three is what a screenful holds. */
const SKELETON_KEYS = ['s1', 's2', 's3', 's4', 's5', 's6'];

type CategoryResponse = {
	slug: string;
	game: string;
	items: Stream[];
	returned: number;
	hasMore: boolean;
	_note?: string;
};

type Load =
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ok'; data: CategoryResponse };

export default function TwitchPage() {
	const [slug, setSlug] = useUrlParam('category', 'just-chatting');
	const [draft, setDraft] = useState('');
	const [load, setLoad] = useState<Load>({ status: 'loading' });

	const fetchCategory = useCallback(async (s: string, signal: AbortSignal) => {
		setLoad({ status: 'loading' });
		try {
			const res = await fetch(`/api/twitch/directory/${encodeURIComponent(s)}/streams`, { signal });
			if (!res.ok) throw new Error(`The route returned HTTP ${res.status}.`);
			setLoad({ status: 'ok', data: (await res.json()) as CategoryResponse });
		} catch (err) {
			if (signal.aborted) return;
			setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) });
		}
	}, []);

	useEffect(() => {
		const ac = new AbortController();
		void fetchCategory(slug, ac.signal);
		return () => ac.abort();
	}, [slug, fetchCategory]);

	return (
		<div className="min-w-0">
			{/* §3: the header block spans the grid and sits clear of the first row
			    by more than one card gap. */}
			<header className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h1 className="text-xl font-semibold">{load.status === 'ok' ? load.data.game : slug}</h1>
				{load.status === 'ok' ? (
					// §3: a run of figures separated by a middle dot.
					<p className="text-[13px] text-muted-foreground">
						{load.data.returned} live {load.data.returned === 1 ? 'stream' : 'streams'} shown
						{load.data.hasMore ? ' · more exist upstream' : ''}
					</p>
				) : null}
				<form
					className="ml-auto flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						const next = draft.trim().toLowerCase().replace(/\s+/g, '-');
						if (next) void setSlug(next);
					}}
				>
					<input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="category"
						aria-label="Category"
						className="h-8 w-40 rounded border bg-background px-2 text-[13px]"
					/>
					<button type="submit" className="h-8 rounded border px-3 text-[13px] hover:bg-muted">
						Go
					</button>
				</form>
			</header>

			{/* §5: _note is content. A grid of N with no explanation is
			    indistinguishable from a category holding N streams. */}
			{load.status === 'ok' && load.data._note ? (
				<p className="mb-4 rounded border border-border bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
					{load.data._note}
				</p>
			) : null}

			{load.status === 'error' ? (
				<p className="text-[13px] text-destructive">
					Could not load {slug}. {load.message}
				</p>
			) : null}

			{load.status === 'ok' && load.data.items.length === 0 ? (
				<p className="text-[13px] text-muted-foreground">
					No live streams in this category right now.
				</p>
			) : null}

			{/* §4/§7 of the skill (G4): a real breakpoint per stated column count. */}
			<div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
				{load.status === 'loading'
					? SKELETON_KEYS.map((k) => <StreamCardSkeleton key={k} />)
					: null}
				{load.status === 'ok'
					? load.data.items.map((s) => <StreamCard key={s.id} stream={s} />)
					: null}
			</div>
		</div>
	);
}
