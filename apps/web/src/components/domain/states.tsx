'use client';

/**
 * The four things a screen says when it is not showing data, and the one line it
 * says when it is showing less than exists.
 *
 * These live together because they are one concern: telling a reader what they
 * are actually looking at. Rendered per-screen, they drifted — the same absence
 * got three wordings and one screen reported a refusal in the same grey as an
 * empty result. A reader cannot act on "nothing here" without knowing which
 * nothing it is.
 *
 * `Completeness` is the load-bearing one. A screen showing N items silently is
 * indistinguishable from a source that holds N items, so where the route says
 * more exists, the screen says so in words — and where the route states no
 * total, the line says the total is unknown rather than substituting the count
 * it happens to have.
 */

/** Nothing has been asked for. Distinct from empty, which is a fact about a query. */
export function NotAsked({ children }: { children: React.ReactNode }) {
	return <p className="py-10 text-center text-[13px] text-muted-foreground">{children}</p>;
}

/** A request ran and matched nothing. */
export function NothingMatched({ children }: { children: React.ReactNode }) {
	return <p className="py-10 text-center text-[13px] text-muted-foreground">{children}</p>;
}

/**
 * The request failed. Carries the route's own words, and is the only one of these
 * in the destructive colour — a refusal a reader mistakes for an empty result is
 * a refusal nobody retries.
 */
export function RouteFailed({ what, message }: { what: string; message: string }) {
	return (
		<p className="py-6 text-[13px] text-destructive">
			Could not load {what}. {message}
		</p>
	);
}

/**
 * What arrived, against what exists upstream.
 *
 * `shown` is counted from the rendered array rather than taken from the route's
 * own `returned`, because those two disagreeing is itself the defect this line
 * exists to surface.
 */
export function Completeness({
	shown,
	returned,
	indicatedTotal,
	hasMore,
	noun,
	note,
}: {
	shown: number;
	returned?: number;
	indicatedTotal?: number | null;
	hasMore?: boolean;
	noun: string;
	note?: string | null;
}) {
	const plural = shown === 1 ? noun : `${noun}s`;
	const disagrees = typeof returned === 'number' && returned !== shown;

	// Nothing to report: the route handed over everything it says exists.
	if (!disagrees && !hasMore && (indicatedTotal == null || indicatedTotal === shown) && !note) {
		return (
			<p className="text-[12px] text-muted-foreground">
				{shown} {plural}, all the route returned.
			</p>
		);
	}

	return (
		<div className="space-y-1">
			<p className={`text-[12px] ${disagrees ? 'text-destructive' : 'text-muted-foreground'}`}>
				{disagrees ? (
					<>
						Showing {shown} {plural}, but the route reported {returned}. Something was dropped
						between the response and this screen.
					</>
				) : indicatedTotal != null && indicatedTotal > shown ? (
					<>
						Showing {shown} of about {indicatedTotal.toLocaleString('en-US')} {plural} upstream —
						the first page.
					</>
				) : (
					<>
						Showing {shown} {plural}. The upstream has more but did not say how many.
					</>
				)}
			</p>
			{/* A note from the route is content, not diagnostics: it is the route
			    explaining a shortfall, and it is the only place that explanation
			    exists. */}
			{note ? <p className="text-[12px] text-muted-foreground">{note}</p> : null}
		</div>
	);
}
