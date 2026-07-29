'use client';

/**
 * One feed post: context line, title, muted action row, thumbnail leading.
 *
 * There are no vote arrows here because our route exposes no write action, and
 * an arrow that cannot vote is worse than no arrow. Score and comment count
 * survive as text, because those are data rather than affordances.
 */

export type Post = {
	id: string;
	title: string;
	permalink: string;
	author: string;
	subreddit: string;
	score: number;
	commentCount: number;
	createdAt: string;
	domain: string | null;
	postType: string;
	contentHref: string | null;
	nsfw: boolean;
};

/** `createdAt` is ISO; the source shows it relative, so the screen converts. */
export function relativeAge(iso: string, now = Date.now()) {
	const ms = now - new Date(iso).getTime();
	if (!Number.isFinite(ms) || ms < 0) return '';
	const mins = Math.floor(ms / 60000);
	if (mins < 60) return `${Math.max(mins, 1)}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** Compact score and comment counts, the way the source shows them. */
export function compactCount(n: number) {
	if (!Number.isFinite(n)) return '0';
	if (Math.abs(n) < 1000) return String(n);
	return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
}

/**
 * `nsfw` is load-bearing. The captured frame showed no blur because that session
 * had the setting disabled — a property of the recording, not of the product —
 * and a signed-out render must not display flagged media.
 */
function showsMedia(post: Post) {
	return !post.nsfw && (post.postType === 'image' || post.postType === 'video');
}

export function PostRow({ post }: { post: Post }) {
	const href = `https://www.reddit.com${post.permalink}`;

	return (
		<article className="flex gap-3 border-b py-3">
			{/* Fixed square thumbnail, roughly three lines tall; postType
			    decides what fills it. */}
			<div className="size-[72px] shrink-0 overflow-hidden rounded bg-muted">
				{showsMedia(post) && post.contentHref ? (
					// biome-ignore lint/performance/noImgElement: upstream hosts are not in next.config images
					<img src={post.contentHref} alt="" className="size-full object-cover" loading="lazy" />
				) : (
					<div className="flex size-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground">
						{post.nsfw ? 'NSFW' : (post.domain ?? post.postType)}
					</div>
				)}
			</div>

			<div className="min-w-0 flex-1">
				{/* Context line above the title. */}
				<div className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
					<span className="font-medium text-foreground">{post.subreddit}</span>
					<span>·</span>
					<time dateTime={post.createdAt}>{relativeAge(post.createdAt)}</time>
					{post.nsfw ? (
						<span className="rounded border border-destructive/40 px-1 text-[10px] text-destructive">
							NSFW
						</span>
					) : null}
				</div>

				<h2 className="mt-0.5 text-[15px] leading-snug font-medium">
					<a href={href} className="text-foreground hover:underline">
						{post.title}
					</a>
				</h2>

				{/* One muted row, data only — no arrows, no award, no share. */}
				<div className="mt-1.5 flex flex-wrap gap-x-4 text-[12px] text-muted-foreground">
					<span>{compactCount(post.score)} points</span>
					<a href={href} className="hover:underline">
						{compactCount(post.commentCount)} comments
					</a>
					<span>u/{post.author}</span>
				</div>
			</div>
		</article>
	);
}

/** A skeleton post at the populated row's rhythm. */
export function PostRowSkeleton() {
	return (
		<div className="flex gap-3 border-b py-3">
			<div className="size-[72px] shrink-0 animate-pulse rounded bg-muted" />
			<div className="min-w-0 flex-1 space-y-2 py-1">
				<div className="h-3 w-24 animate-pulse rounded bg-muted-foreground/15" />
				<div className="h-4 w-3/4 animate-pulse rounded bg-muted-foreground/20" />
				<div className="h-3 w-40 animate-pulse rounded bg-muted-foreground/10" />
			</div>
		</div>
	);
}
