/**
 * Traffic Capture Filter
 *
 * Which responses are worth keeping as captured traffic, and how their bodies
 * are parsed. Extracted so the CDP capture path and the protocol-agnostic
 * (driver) capture path apply exactly the same rules — a filter that differs
 * between paths would make "this transport is absent" mean different things
 * depending on which browser was running, which is the one answer discovery
 * cannot afford to get wrong.
 *
 * Pure. No browser, no protocol.
 *
 * @module browser/driver/capture-filter
 */

/** Resource types that carry API data. Everything else is page furniture. */
export const DATA_RESOURCE_TYPES = ['xhr', 'fetch'] as const;

/**
 * Content types that are never API data.
 *
 * Markup is excluded here because a *document* is captured through its own
 * path, with its own marker — an HTML body arriving on the XHR path is an
 * error page or a challenge, not a result.
 */
const NON_DATA_CONTENT_TYPES = ['text/html', 'text/css', 'image/', 'font/', 'video/', 'audio/'];

/** Third parties whose traffic is telemetry rather than the site's own API. */
const TELEMETRY_HOSTS = [
	'google-analytics',
	'googleadservices',
	'google.com/ccm',
	'googletagmanager',
	'sentry.io',
	'forter.com',
	'riskified.com',
	'doubleclick.net',
	'facebook.com/tr',
	'segment.io',
	'amplitude.com',
	'datadoghq.com',
	'newrelic.com',
];

/**
 * URLs an engine generates for its own plumbing.
 *
 * These are not the site's traffic and recording them puts engine artifacts in
 * a manifest that is supposed to describe a target — worse, they are documents,
 * so they survive a filter aimed at data content types.
 */
const ENGINE_INTERNAL = ['patchright-init-script-inject', 'playwright-init-script', 'about:blank'];

/** True when a URL belongs to the browser engine rather than to the site. */
export function isEngineInternal(url: string): boolean {
	return ENGINE_INTERNAL.some((marker) => url.includes(marker));
}

/** Case-insensitive header lookup — protocols disagree about casing. */
export function header(headers: Record<string, string> | undefined, name: string): string {
	if (!headers) return '';
	const key = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
	return key ? String(headers[key]) : '';
}

/** True when a URL belongs to a telemetry vendor rather than the site's API. */
export function isTelemetry(url: string): boolean {
	return TELEMETRY_HOSTS.some((host) => url.includes(host));
}

/**
 * True when a script response is worth reading rather than skipping.
 *
 * Bundles are page furniture and there are hundreds of them. A script carrying
 * a query string is usually not furniture though — it is a call, and classic
 * JSONP is exactly that: a `<script src>` whose response is a bare function
 * invocation wrapping the data. The strictest form has no callback parameter at
 * all, just a hardcoded global, so nothing in the request distinguishes it and
 * only the body does. Skipping every script meant that transport could not be
 * seen at all.
 */
export function isCandidateScript(url: string): boolean {
	if (!url.includes('?')) return false;
	// Cache-busting on a real bundle: a hashed filename with a version param is
	// still furniture.
	return !/\.(?:js|mjs)\?(?:v|ver|version|hash|t|cb)=[\w.-]+$/i.test(url);
}

/** True when a content type carries API data rather than page furniture. */
export function isDataContentType(contentType: string): boolean {
	const ct = contentType.toLowerCase();
	if (!ct) return true; // no content-type stated — keep it and let classification decide
	return !NON_DATA_CONTENT_TYPES.some((skip) => ct.includes(skip));
}

/**
 * Whether a response should be captured as traffic.
 *
 * Returns a reason when it should not, so a caller can report *why* something
 * was dropped instead of it silently vanishing.
 */
export function captureDecision(input: {
	url: string;
	resourceType?: string;
	contentType?: string;
}): { capture: true } | { capture: false; reason: string } {
	if (isTelemetry(input.url)) return { capture: false, reason: 'telemetry host' };

	if (input.resourceType && !DATA_RESOURCE_TYPES.includes(input.resourceType as 'xhr' | 'fetch')) {
		// A script carrying a query string is a call, not furniture. JSONP in its
		// strictest form has no callback parameter — the response is a bare
		// invocation of a hardcoded global — so nothing in the request marks it and
		// skipping every script made the transport undetectable.
		if (input.resourceType === 'script' && isCandidateScript(input.url)) {
			return { capture: true };
		}
		return { capture: false, reason: `resource type "${input.resourceType}"` };
	}
	if (!isDataContentType(input.contentType ?? '')) {
		return { capture: false, reason: `content type "${input.contentType}"` };
	}
	return { capture: true };
}

/**
 * Parse a body as JSON when it is JSON, otherwise return it unchanged.
 *
 * Never throws: an unparseable body is data about the response, and discarding
 * it would hide exactly the case worth seeing.
 */
export function parseBody(raw: string | null | undefined): unknown {
	if (raw === null || raw === undefined || raw === '') return raw ?? null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

/** What a large body is reduced to when it will not be kept whole. */
export interface BodyDigest {
	_truncated: true;
	_size: number;
	_preview: string;
	/** Embedded-data regions found past the preview, kept because they are the point. */
	_embedded?: string[];
}

/**
 * Markers whose surrounding region is worth keeping out of an oversized body.
 *
 * Framework hydration and semantic markup both sit deep in a document — after
 * the head, often after the visible content — so a head-slice discards exactly
 * the thing a document is captured for.
 */
const EMBEDDED_MARKERS = [
	/<script[^>]+type=["']application\/(?:ld\+)?json["'][^>]*>/gi,
	/__NEXT_DATA__|__NUXT_DATA__|__NUXT__|__PRELOADED_STATE__|__INITIAL_STATE__/g,
	/__APOLLO_STATE__|__remixContext|__staticRouterHydrationData|__RELAY_PAYLOADS__/g,
	/data-sveltekit-fetched|self\.__next_f/g,
];

/**
 * Reduce an oversized body, keeping signal rather than position.
 *
 * A head-preview is the obvious reduction and the wrong one: it keeps the part
 * of a page that is always the same and drops the part that differs. A
 * server-rendered page routinely carries its whole payload in a script tag past
 * the cutoff, so a preview-only digest reported the site as having no embedded
 * data while the data sat in the body that was thrown away.
 *
 * Bounded on both sides: a fixed preview plus a fixed number of fixed-size
 * regions, so a pathological page cannot defeat the cap it exists to enforce.
 */
export function digestLargeBody(
	bodyStr: string,
	limits: { preview?: number; region?: number; maxRegions?: number } = {},
): BodyDigest {
	const preview = limits.preview ?? 2_000;
	const region = limits.region ?? 4_000;
	const maxRegions = limits.maxRegions ?? 6;

	const embedded: string[] = [];
	const seen = new Set<number>();
	for (const re of EMBEDDED_MARKERS) {
		re.lastIndex = 0;
		for (const m of bodyStr.matchAll(re)) {
			if (embedded.length >= maxRegions) break;
			const at = m.index ?? 0;
			// One marker per neighbourhood: several markers inside one payload would
			// otherwise spend the whole budget re-copying the same region.
			if ([...seen].some((prev) => Math.abs(prev - at) < region)) continue;
			seen.add(at);
			embedded.push(bodyStr.slice(at, at + region));
		}
	}

	return {
		_truncated: true,
		_size: bodyStr.length,
		_preview: bodyStr.slice(0, preview),
		...(embedded.length ? { _embedded: embedded } : {}),
	};
}
