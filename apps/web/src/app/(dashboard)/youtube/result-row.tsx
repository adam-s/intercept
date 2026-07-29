'use client';

/**
 * One search result: a still at the leading edge, a text column beside it.
 *
 * Two variants of this row exist and the difference is deliberately visible. The
 * upstream serves results through two renderers and only one of them carries a
 * channel name and a duration; the other carries neither. So both fields are
 * optional here, and an absent one removes its element rather than rendering an
 * empty slot — "by " with nothing after it, or a bare duration chip, would both
 * be this screen asserting something the response never said.
 *
 * `views` and `published` arrive already formatted as prose, and `views` carries
 * its own label: a live result reads "1.1K watching" where a recorded one reads
 * "205K views". Appending a word to either produces "1.1K watching views", so
 * these strings are printed verbatim.
 */

import { useState } from 'react';

export type Result = {
	videoId: string;
	title: string;
	views: string | null;
	published: string | null;
	thumbnail?: string | null;
	channel?: string | null;
	duration?: string | null;
	_renderer?: string;
};

export function ResultRow({ result }: { result: Result }) {
	const [stillFailed, setStillFailed] = useState(false);
	const href = `https://www.youtube.com/watch?v=${encodeURIComponent(result.videoId)}`;
	const meta = [result.views, result.published].filter(Boolean);

	return (
		<article className="flex flex-col gap-3 sm:flex-row">
			{/* Rigid in aspect: the still absorbs width by scaling, and the text
			    column never grows to match its height. Wider than a third and
			    narrower than a half of the row above the narrow viewport; full
			    width below it, where a side-by-side row leaves the title two words
			    per line. */}
			<a
				href={href}
				className="relative block aspect-video w-full shrink-0 overflow-hidden rounded-md bg-muted sm:w-[38%]"
			>
				{result.thumbnail && !stillFailed ? (
					// biome-ignore lint/performance/noImgElement: upstream CDN hosts are not configured for next/image
					<img
						src={result.thumbnail}
						alt=""
						loading="lazy"
						onError={() => setStillFailed(true)}
						className="size-full object-cover"
					/>
				) : (
					// The well keeps the row's shape. A list that reflows as pictures
					// resolve is worse to read than one with a gap in it.
					<span className="sr-only">No preview picture</span>
				)}

				{/* Trailing-bottom, over a scrim, because the text sits on picture. */}
				{result.duration ? (
					<span className="absolute right-1 bottom-1 rounded-[3px] bg-black/75 px-1 text-[11px] leading-[16px] font-medium text-white tabular-nums">
						{result.duration}
					</span>
				) : null}
			</a>

			{/* Topped, not centred: a short text column leaves space beneath it. */}
			<div className="min-w-0 flex-1">
				<h2 className="text-[15px] leading-[21px] font-medium">
					<a href={href} className="line-clamp-2 text-foreground hover:underline">
						{result.title}
					</a>
				</h2>

				{meta.length > 0 ? (
					<p className="mt-1 text-[12px] text-muted-foreground">{meta.join(' · ')}</p>
				) : null}

				{result.channel ? (
					<p className="mt-1.5 truncate text-[12px] text-muted-foreground">{result.channel}</p>
				) : null}
			</div>
		</article>
	);
}

/** Loading holds the populated row's rhythm, so nothing reflows when data lands. */
export function ResultRowSkeleton() {
	return (
		<div className="flex flex-col gap-3 sm:flex-row">
			<div className="aspect-video w-full shrink-0 animate-pulse rounded-md bg-muted sm:w-[38%]" />
			<div className="min-w-0 flex-1 space-y-2">
				<div className="h-[21px] w-11/12 animate-pulse rounded bg-muted-foreground/20" />
				<div className="h-[21px] w-2/3 animate-pulse rounded bg-muted-foreground/20" />
				<div className="h-3 w-40 animate-pulse rounded bg-muted-foreground/10" />
				<div className="h-3 w-28 animate-pulse rounded bg-muted-foreground/10" />
			</div>
		</div>
	);
}
