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
 * A video card, from whichever renderer carries it.
 *
 * Two shapes are in circulation — the long-standing `videoRenderer` and the
 * newer `lockupViewModel` — and a surface may serve either. Reading only the
 * one you first met returns an empty list on the other, which looks exactly
 * like a page with no videos.
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
			views: parts.find((part: string) => /view/i.test(part)) ?? null,
			published: parts.find((part: string) => /ago$/i.test(part)) ?? null,
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
