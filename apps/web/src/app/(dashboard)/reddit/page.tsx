'use client';

/**
 * Reddit feed, built from .snapshots/frame-reddit/description.md and nothing
 * else.
 *
 * §9: the frame's own header and left nav are cut rather than stacked — the app
 * shell already provides navigation. What survives from the header is the sort
 * control, which is screen state rather than site chrome.
 */

import { useCallback, useEffect, useState } from 'react';
import { useUrlParam } from '@/lib/url-state';
import { type Post, PostRow, PostRowSkeleton } from './post-row';

/** §6: five skeleton posts, matching the frame's per-screenful density. */
const SKELETON_KEYS = ['s1', 's2', 's3', 's4', 's5'];

type FeedResponse = {
	sort: string;
	posts: Post[];
	returned: number;
	hasMore: boolean;
	nextCursor: { after?: string; cursor?: string } | null;
};

type Load =
	| { status: 'loading' }
	| { status: 'error'; message: string }
	| { status: 'ok'; data: FeedResponse };

export default function RedditPage() {
	const [subreddit, setSubreddit] = useUrlParam('r', '');
	const [load, setLoad] = useState<Load>({ status: 'loading' });
	const [draft, setDraft] = useState('');

	const fetchFeed = useCallback(async (sub: string, signal: AbortSignal) => {
		setLoad({ status: 'loading' });
		const path = sub ? `/api/reddit/r/${encodeURIComponent(sub)}` : '/api/reddit/popular';
		try {
			const res = await fetch(path, { signal });
			if (!res.ok) throw new Error(`The route returned HTTP ${res.status}.`);
			setLoad({ status: 'ok', data: (await res.json()) as FeedResponse });
		} catch (err) {
			if (signal.aborted) return;
			setLoad({ status: 'error', message: err instanceof Error ? err.message : String(err) });
		}
	}, []);

	useEffect(() => {
		const ac = new AbortController();
		void fetchFeed(subreddit, ac.signal);
		return () => ac.abort();
	}, [subreddit, fetchFeed]);

	return (
		// §2/§7: the feed is the only region that survives §10. Full width narrow,
		// constrained above — the right rail and left nav were cut, not shrunk.
		<div className="mx-auto w-full min-w-0 max-w-3xl">
			<div className="mb-3 flex flex-wrap items-center gap-2">
				<h1 className="text-base font-semibold">{subreddit ? `r/${subreddit}` : 'Popular'}</h1>
				{load.status === 'ok' ? (
					<span className="text-[12px] text-muted-foreground">sorted by {load.data.sort}</span>
				) : null}
				<form
					className="ml-auto flex gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void setSubreddit(draft.replace(/^\/?r\//, '').trim());
					}}
				>
					<input
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="subreddit"
						aria-label="Subreddit"
						className="h-8 w-36 rounded border bg-background px-2 text-[13px]"
					/>
					<button type="submit" className="h-8 rounded border px-3 text-[13px] hover:bg-muted">
						Go
					</button>
					{subreddit ? (
						<button
							type="button"
							onClick={() => {
								setDraft('');
								void setSubreddit('');
							}}
							className="h-8 rounded px-2 text-[13px] text-muted-foreground hover:underline"
						>
							Clear
						</button>
					) : null}
				</form>
			</div>

			{load.status === 'loading' ? SKELETON_KEYS.map((k) => <PostRowSkeleton key={k} />) : null}

			{/* §6: error and empty are visibly distinct. */}
			{load.status === 'error' ? (
				<p className="py-3 text-[13px] text-destructive">
					Could not load {subreddit ? `r/${subreddit}` : 'the popular feed'}. {load.message}
				</p>
			) : null}

			{load.status === 'ok' && load.data.posts.length === 0 ? (
				<p className="py-3 text-[13px] text-muted-foreground">This feed returned no posts.</p>
			) : null}

			{load.status === 'ok' && load.data.posts.length > 0 ? (
				<>
					{load.data.posts.map((p) => (
						// §5: keyed by id, never the array index.
						<PostRow key={p.id} post={p} />
					))}

					{/* §6 Partial — the state that matters on this route. Rendering N
					    posts silently is indistinguishable from a quiet day, so the
					    screen says what it actually received whenever more exists. */}
					{load.data.hasMore ? (
						<p className="py-3 text-[12px] text-muted-foreground">
							Showing {load.data.posts.length} post
							{load.data.posts.length === 1 ? '' : 's'}
							{load.data.returned !== load.data.posts.length
								? ` (route reported ${load.data.returned})`
								: ''}
							. The upstream has more — this is a partial page, not the whole feed.
						</p>
					) : null}
				</>
			) : null}
		</div>
	);
}
