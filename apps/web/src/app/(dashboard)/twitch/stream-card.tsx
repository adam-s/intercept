'use client';

/**
 * One stream card: a still, then a caption of title / channel / tags.
 *
 * The still is its own edge — no border, no shadow, radius a small fraction of
 * its height — and the title yields first, eliding before the channel name does,
 * because two elements competing for one row must have a stated loser.
 */

import { useState } from 'react';

export type Stream = {
	id: string;
	title: string;
	viewersCount: number;
	previewImageURL: string;
	type: string;
	broadcaster: { login: string; displayName: string; roles?: { isPartner?: boolean } | null };
	freeformTags?: { name: string }[] | null;
	contentClassificationLabels?: { id: string }[] | null;
};

/** Viewer counts are read at a glance, so they shorten rather than wrap. */
export function compactViewers(n: number) {
	if (!Number.isFinite(n)) return '0';
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function StreamCard({ stream }: { stream: Stream }) {
	const [stillFailed, setStillFailed] = useState(false);
	const href = `https://www.twitch.tv/${stream.broadcaster.login}`;
	const tags = stream.freeformTags ?? [];
	const labels = stream.contentClassificationLabels ?? [];

	return (
		<article className="min-w-0">
			{/* 16:9, rigid in aspect — absorbs width by scaling. */}
			<a href={href} className="relative block aspect-video overflow-hidden rounded-sm bg-muted">
				{stillFailed ? (
					// A failed still keeps the card's shape and shows the channel
					// instead. A grid that reflows while being read is worse than a
					// card with no picture in it.
					<div className="flex size-full items-center justify-center px-2 text-center text-[13px] text-muted-foreground">
						{stream.broadcaster.displayName}
					</div>
				) : (
					// biome-ignore lint/performance/noImgElement: upstream CDN hosts are not configured for next/image
					<img
						src={stream.previewImageURL}
						alt=""
						loading="lazy"
						onError={() => setStillFailed(true)}
						className="size-full object-cover"
					/>
				)}

				{/* Leading-top, inset by less than its own height. */}
				{stream.type === 'live' ? (
					<span className="absolute top-1 left-1 rounded-[2px] bg-destructive px-1 text-[11px] font-semibold uppercase leading-[16px] text-white">
						Live
					</span>
				) : null}

				{/* Leading-bottom, same inset. The scrim exists because this text sits
				    over unpredictable video. */}
				<span className="absolute bottom-1 left-1 rounded-[2px] bg-black/70 px-1 text-[11px] leading-[16px] text-white">
					{compactViewers(stream.viewersCount)} viewers
				</span>
			</a>

			{/* Avatar leading, a two-line stack taking the rest. */}
			<div className="mt-2 flex gap-2">
				<div className="mt-0.5 size-8 shrink-0 rounded-full bg-muted" aria-hidden />
				<div className="min-w-0 flex-1">
					<a
						href={href}
						className="block truncate text-[13px] font-semibold text-foreground hover:underline"
						title={stream.title}
					>
						{stream.title}
					</a>
					<div className="flex min-w-0 items-center gap-0.5 text-[13px] text-muted-foreground">
						<span className="truncate">{stream.broadcaster.displayName}</span>
						{stream.broadcaster.roles?.isPartner ? (
							<span role="img" aria-label="Partner" title="Partner" className="shrink-0">
								✓
							</span>
						) : null}
					</div>
				</div>
			</div>

			{/* Pills wrapping to at most one extra line; overflow dropped. */}
			{tags.length > 0 || labels.length > 0 ? (
				<div className="mt-1.5 flex max-h-[44px] flex-wrap gap-1 overflow-hidden">
					{labels.map((l) => (
						<span
							key={`l-${l.id}`}
							className="rounded-full border border-destructive/40 px-2 text-[11px] leading-[20px] text-destructive"
						>
							{l.id.replace(/([a-z])([A-Z])/g, '$1 $2')}
						</span>
					))}
					{tags.slice(0, 4).map((t) => (
						<span
							key={t.name}
							className="rounded-full bg-muted px-2 text-[11px] leading-[20px] text-muted-foreground"
						>
							{t.name}
						</span>
					))}
				</div>
			) : null}
		</article>
	);
}

/** Loading holds the populated rhythm so nothing reflows when data lands. */
export function StreamCardSkeleton() {
	return (
		<div className="min-w-0">
			<div className="aspect-video animate-pulse rounded-sm bg-muted" />
			<div className="mt-2 flex gap-2">
				<div className="mt-0.5 size-8 shrink-0 animate-pulse rounded-full bg-muted" />
				<div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
					<div className="h-3.5 w-4/5 animate-pulse rounded bg-muted-foreground/20" />
					<div className="h-3.5 w-2/5 animate-pulse rounded bg-muted-foreground/10" />
				</div>
			</div>
			<div className="mt-1.5 h-5 w-1/2 animate-pulse rounded-full bg-muted" />
		</div>
	);
}
