/**
 * The one place this domain talks to Yahoo, and the one place it decides that an
 * answer is not data.
 *
 * Two facts from elimination shape everything here.
 *
 * **`query*.finance.yahoo.com` refuses with a document, not a status a parser
 * notices.** Over its limit it answers `429` with `text/html` carrying an
 * obfuscated script — no WAF vendor header, so the framework's header-only
 * challenge guard cannot see it. A route that calls `.json()` on that gets a
 * throw with a confusing message, and a route that reads `.text()` stores a
 * challenge page as a result. So every response is checked for shape before
 * anything reads it, and a refusal is raised rather than returned.
 *
 * **The document's origin is a credential.** These endpoints answer a
 * cross-origin request from a page on `finance.yahoo.com` and refuse the same
 * request once the document is reseated onto the API host, because reseating
 * discards the `Origin` and `Referer` they check. Hence `navigateTo` on every
 * browser-rung call: same-origin is a convenience for CORS, never a credential.
 *
 * @module domain-yahoofinance/yahoo-api
 */

import type { RemoteBrowserService } from '@interceptor/browser/remote/service';
import { DEBUG, rateLimitedFetch } from '@interceptor/shared';
import type { Context } from 'hono';

/** The page every browser-rung call is issued from. See the module note. */
export const SITE_ORIGIN = 'https://finance.yahoo.com';

/** Hosts this domain reaches, named so a typo is a compile error. */
export const QUERY_HOST = 'query1.finance.yahoo.com';

/**
 * An upstream answer that is not data.
 *
 * Deliberately not a subclass of the framework's `TransportTierError`: that one
 * means the ladder was crossed wrongly, which is a bug in our code. This means
 * the upstream declined, which is a fact about the run — usually a request rate
 * that we set. Never retried: re-sending deepens our own footprint and the first
 * response already said everything.
 */
export class YahooRefusal extends Error {
	constructor(
		readonly status: number,
		readonly contentType: string,
		readonly url: string,
		readonly hint: string,
	) {
		super(`${new URL(url).host} answered ${status} ${contentType || '(no type)'} — ${hint}`);
		this.name = 'YahooRefusal';
	}
}

/** Percent-encoded and joined, so a symbol containing `^` or `=` survives. */
export function symbolList(raw: string | undefined, fallback: string, max = 25): string[] {
	return String(raw ?? fallback)
		.split(',')
		.map((s) => s.trim().toUpperCase())
		.filter(Boolean)
		.slice(0, max);
}

/**
 * Decide whether a response is data, before anything parses it.
 *
 * `data` is inspected rather than the body re-read, because the browser rung has
 * already parsed it — and a string body where an object was expected is the
 * exact shape of Yahoo's interstitial.
 */
function assertData(status: number, contentType: string, data: unknown, url: string): void {
	if (status === 429) {
		throw new YahooRefusal(
			status,
			contentType,
			url,
			'rate limited. This is a request rate we set, not a property of the site — let it clear rather than retrying',
		);
	}
	if (status < 200 || status >= 300) {
		throw new YahooRefusal(status, contentType, url, 'non-success status');
	}
	if (/text\/html/i.test(contentType) || typeof data === 'string') {
		throw new YahooRefusal(
			status,
			contentType,
			url,
			'a document where JSON was expected — an interstitial, not a result',
		);
	}
}

/**
 * The browser rung: issued from a page on the site, cross-origin, with cookies.
 *
 * This is the first rung and the default for anything on `query*`, because the
 * request carries the browser's own TLS handshake and the site's session. The
 * cost is a navigation, so the page is only moved when it is somewhere else.
 */
export async function fromPage<T>(
	browser: RemoteBrowserService,
	url: string,
	init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
	const res = await browser.browserFetch<T>(url, {
		method: init.method ?? 'GET',
		...(init.body === undefined ? {} : { body: init.body }),
		...(init.body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
		navigateTo: SITE_ORIGIN,
	});
	assertData(res.status, res.headers['content-type'] ?? '', res.data, url);
	return res.data;
}

/**
 * The direct rung, for endpoints elimination proved need nothing the browser
 * carries. Callers name the endpoint in their own comment; this only enforces
 * that the answer is data.
 *
 * Anything issued here has the runtime's TLS fingerprint rather than a
 * browser's. A route on this rung that starts failing for no visible reason
 * should move to `fromPage` before anything else is investigated.
 */
export async function direct<T>(
	url: string,
	init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<T> {
	const res = await rateLimitedFetch(url, {
		method: init.method ?? 'GET',
		...(init.body === undefined
			? {}
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
	});
	const contentType = res.headers.get('content-type') ?? '';
	// Read as text first: calling .json() on the interstitial throws a parse
	// error that reads like our bug rather than Yahoo's refusal.
	const text = await res.text();
	let data: unknown = text;
	if (/application\/json/i.test(contentType)) {
		try {
			data = JSON.parse(text);
		} catch {
			data = text;
		}
	}
	assertData(res.status, contentType, data, url);
	return data as T;
}

/** Direct rung for endpoints that legitimately answer with markup. */
export async function directHtml(url: string): Promise<string> {
	const res = await rateLimitedFetch(url);
	const text = await res.text();
	if (res.status !== 200) {
		throw new YahooRefusal(res.status, res.headers.get('content-type') ?? '', url, 'non-200 page');
	}
	return text;
}

/**
 * The uniform way a route reports a refusal.
 *
 * A give-up is a first-class outcome: the caller gets the status, the content
 * type and why, never an empty list that reads as "the site has no such data".
 */
export function refused(c: Context, err: unknown, context: Record<string, unknown> = {}): Response {
	if (err instanceof YahooRefusal) {
		DEBUG('yahoofinance', `refusal: ${err.message}`);
		return c.json(
			{
				error: 'upstream declined',
				upstreamStatus: err.status,
				upstreamContentType: err.contentType,
				url: err.url,
				hint: err.hint,
				...context,
			},
			502,
		);
	}
	DEBUG('yahoofinance', `unexpected: ${String(err)}`);
	return c.json({ error: String(err).slice(0, 300), ...context }, 502);
}
