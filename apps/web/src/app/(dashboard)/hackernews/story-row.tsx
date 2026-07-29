'use client';

/**
 * One story, two lines: title line and metadata line.
 *
 * Built from .snapshots/frame-1-hn/description.md §5, which pins the two item
 * variants that exist in the route's real data — a job post whose `points` and
 * `author` are null, and a story whose `commentCount` is 0. Rendering
 * "null points by null" is the defect this component exists to prevent.
 *
 * §8: the frame's density and two-line rhythm carry over; its palette does not.
 * Colors are semantic tokens so the row stays legible in either theme mode.
 */

export type Story = {
	id: string;
	rank: number;
	title: string;
	url: string;
	site: string | null;
	points: number | null;
	author: string | null;
	ageISO: string;
	ageText: string;
	commentCount: number | null;
	commentsUrl: string;
};

/** The source site's item permalink; the route returns it relative. */
function itemHref(commentsUrl: string) {
	return `https://news.ycombinator.com/${commentsUrl.replace(/^\/+/, '')}`;
}

export function StoryRow({ story }: { story: Story }) {
	const { rank, title, url, site, points, author, ageISO, ageText, commentCount } = story;

	// A job post carries neither score nor submitter. §5: the metadata line
	// collapses to age alone rather than rendering empty slots.
	const hasByline = points !== null && author !== null;

	return (
		<li className="flex gap-1.5 py-[3px] text-[13px] leading-[17px]">
			<span className="w-7 shrink-0 text-right text-muted-foreground tabular-nums">{rank}.</span>
			<span aria-hidden className="shrink-0 text-muted-foreground">
				▲
			</span>
			<div className="min-w-0">
				<span>
					<a href={url} className="text-foreground hover:underline">
						{title}
					</a>
					{site ? <span className="ml-1 text-[11px] text-muted-foreground">({site})</span> : null}
				</span>
				<div className="text-[11px] leading-[15px] text-muted-foreground">
					{hasByline ? (
						<>
							{points} points by {author}{' '}
						</>
					) : null}
					<time dateTime={ageISO}>{ageText}</time>
					{' | '}
					<a href={itemHref(story.commentsUrl)} className="hover:underline">
						{commentCount ? `${commentCount} comments` : 'discuss'}
					</a>
				</div>
			</div>
		</li>
	);
}

/** Loading placeholder at the populated row's exact rhythm, so nothing reflows. */
export function StoryRowSkeleton() {
	return (
		<li className="flex gap-1.5 py-[3px]">
			<span className="w-7 shrink-0" />
			<div className="min-w-0 flex-1">
				<div className="h-[17px] w-[55%] animate-pulse rounded bg-muted-foreground/20" />
				<div className="mt-[2px] h-[15px] w-[32%] animate-pulse rounded bg-muted-foreground/10" />
			</div>
		</li>
	);
}
