/**
 * InnerTube — YouTube's own API, called the way the page calls it.
 *
 * Every request is a POST carrying a `context.client` block that describes the
 * client making it. That block is not decoration: the same path returns
 * different data to different client identities, so it is a discovery axis
 * rather than a parameter, and a caller that never varies it has seen one view
 * of the surface.
 *
 * Calls go through the page rather than the runtime. The endpoint is
 * same-origin to a watch page, the session and its cookies are already there,
 * and a request issued inside the browser carries the browser's TLS handshake —
 * which a site that fingerprints will check.
 *
 * @module domain-youtube/innertube
 */

/** The web client the page itself reports. Varying this varies the response. */
export const WEB_CLIENT = {
	clientName: 'WEB',
	clientVersion: '2.20240726.00.00',
	hl: 'en',
	gl: 'US',
};

/** Build the body every InnerTube endpoint expects. */
export function innertubeBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { context: { client: WEB_CLIENT }, ...extra };
}

/**
 * Walk a renderer tree collecting every node under a key.
 *
 * InnerTube nests results several layers deep and moves the layers between
 * surfaces, so addressing them by path breaks whenever a surface is
 * reorganised. Searching by node type survives that: the container changes, the
 * item does not.
 */
export function collectRenderers(
	node: unknown,
	key: string,
	found: Record<string, unknown>[] = [],
	depth = 0,
): Record<string, unknown>[] {
	// Bounded so a cyclic or pathologically deep payload cannot hang a route.
	if (depth > 30 || found.length > 200 || node === null || typeof node !== 'object') return found;
	if (Array.isArray(node)) {
		for (const item of node) collectRenderers(item, key, found, depth + 1);
		return found;
	}
	for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
		if (k === key && v && typeof v === 'object') found.push(v as Record<string, unknown>);
		else collectRenderers(v, key, found, depth + 1);
	}
	return found;
}

/**
 * Flatten the three text shapes InnerTube uses.
 *
 * `{ simpleText }` and `{ runs: [{ text }] }` are the long-standing pair; the
 * view-model surfaces use `{ content }`. Reading only the first two returns an
 * empty string on the third, which reads as a video with no title rather than
 * as a shape that was not handled.
 */
export function textOf(node: unknown): string {
	if (typeof node === 'string') return node;
	if (!node || typeof node !== 'object') return '';
	const n = node as { simpleText?: string; content?: string; runs?: Array<{ text?: string }> };
	if (typeof n.simpleText === 'string') return n.simpleText;
	if (typeof n.content === 'string') return n.content;
	if (Array.isArray(n.runs)) return n.runs.map((r) => r.text ?? '').join('');
	return '';
}

/**
 * Pull the loose metadata line a view-model card carries.
 *
 * Views and age arrive as an ordered list of parts with no labels — "2.3M
 * views", "2 days ago" — so they are matched by content rather than position.
 * Position would work today and break the first time a surface adds a part.
 */
function metadataParts(meta: unknown): string[] {
	const rows = collectRenderers(meta, 'contentMetadataViewModel');
	const parts: string[] = [];
	for (const row of rows) {
		for (const r of (row.metadataRows as Array<Record<string, unknown>>) ?? []) {
			for (const part of (r.metadataParts as Array<Record<string, unknown>>) ?? []) {
				const t = textOf(part.text);
				if (t) parts.push(t);
			}
		}
	}
	return parts;
}

/**
 * The widest picture a card carries, or null when it carries none.
 *
 * The two renderers nest their images differently and under different keys —
 * `thumbnails` on the classic one, `sources` on the view-model one — so this
 * searches for either by key rather than by path, the same reason
 * `collectRenderers` exists. Widest rather than first: the arrays are not
 * ordered consistently across surfaces, and the smallest entry is a placeholder
 * that renders as a blur.
 *
 * A card with no picture returns null and says so. Composing the URL from the
 * video id instead would produce a link that works, and would be a fact this
 * response never contained.
 */
export function thumbnailOf(node: unknown, depth = 0): string | null {
	if (depth > 12 || node === null || typeof node !== 'object') return null;
	let best: { url: string; width: number } | null = null;
	const consider = (list: unknown) => {
		if (!Array.isArray(list)) return;
		for (const entry of list) {
			if (!entry || typeof entry !== 'object') continue;
			const { url, width } = entry as { url?: unknown; width?: unknown };
			if (typeof url !== 'string' || !url) continue;
			const w = typeof width === 'number' ? width : 0;
			if (!best || w > best.width) best = { url, width: w };
		}
	};

	if (Array.isArray(node)) {
		for (const item of node) {
			const found = thumbnailOf(item, depth + 1);
			if (found) return found;
		}
		return null;
	}
	for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
		if (k === 'thumbnails' || k === 'sources') consider(v);
		else if (!best) {
			const found = thumbnailOf(v, depth + 1);
			if (found) return found;
		}
	}
	return best ? (best as { url: string }).url : null;
}

/**
 * Whether the upstream held back a continuation.
 *
 * This is the only honest source for "there is more". A count comparison cannot
 * supply it here: the response states no total, so comparing the returned count
 * against anything derived from the same response compares a number with itself
 * and always agrees.
 */
export function hasContinuation(payload: unknown): boolean {
	return collectRenderers(payload, 'continuationItemRenderer').length > 0;
}

/**
 * The upstream's own count of matching videos, when it states one.
 *
 * Returns null rather than a substitute. A search that reports its own page size
 * as the total is indistinguishable from a search that found exactly one page of
 * matches, and the second is almost never true.
 *
 * UNVERIFIED BY PROBE (2026-07-29): `estimatedResults` is read defensively
 * because this key's presence has not been confirmed against a live search
 * response in this repo. Absent, the route reports no total — which is the
 * correct outcome either way, and is why this is safe to ship unprobed.
 */
export function estimatedResults(payload: unknown): number | null {
	if (!payload || typeof payload !== 'object') return null;
	const raw = (payload as { estimatedResults?: unknown }).estimatedResults;
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
	// InnerTube sends 64-bit counts as strings; Number() on a huge one is still
	// the right order of magnitude, which is all a "of about N" line needs.
	if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
	return null;
}

/**
 * A video card, from whichever renderer carries it.
 *
 * Two shapes are in circulation — the long-standing `videoRenderer` and the
 * newer `lockupViewModel` — and a surface may serve either. Reading only the
 * one you first met returns an empty list on the other, which looks exactly
 * like a page with no videos.
 *
 * The two do not carry the same fields, and the difference is passed through
 * rather than smoothed over: a card with no channel name omits the key, so a
 * consumer can tell "this surface does not say" from "the channel is empty".
 */
export function videoCards(payload: unknown): Array<Record<string, unknown>> {
	const classic = collectRenderers(payload, 'videoRenderer').map((v) => ({
		videoId: v.videoId,
		title: textOf(v.title),
		channel: textOf(
			(v.ownerText ?? v.longBylineText ?? v.shortBylineText) as Record<string, unknown>,
		),
		published: textOf(v.publishedTimeText),
		views: textOf(v.viewCountText),
		duration: textOf(v.lengthText),
		thumbnail: thumbnailOf(v.thumbnail),
		_renderer: 'videoRenderer',
	}));
	const modern = collectRenderers(payload, 'lockupViewModel').map((v) => {
		const lockup = (v.metadata as { lockupMetadataViewModel?: Record<string, unknown> } | undefined)
			?.lockupMetadataViewModel;
		const parts = metadataParts(lockup);
		return {
			videoId: v.contentId,
			title: textOf(lockup?.title),
			// Matched by content, not by index: these parts arrive unlabelled and a
			// surface may add one without warning, which would shift every position.
			views: parts.find((part: string) => /view|watching/i.test(part)) ?? null,
			published: parts.find((part: string) => /ago$/i.test(part)) ?? null,
			thumbnail: thumbnailOf(v.contentImage),
			_renderer: 'lockupViewModel',
		};
	});
	const seen = new Set<unknown>();
	return [...classic, ...modern].filter((v) => {
		if (!v.videoId || seen.has(v.videoId)) return false;
		seen.add(v.videoId);
		return true;
	});
}
