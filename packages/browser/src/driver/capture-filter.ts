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
