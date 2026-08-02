/**
 * Credentials for the search transport HN's own search box submits to.
 *
 * The `<form method="get" action="//hn.algolia.com/">` in every Hacker News
 * footer full-navigates to a second application. That application is a React
 * SPA, and pressing Enter in the HN search box is the only thing that reaches
 * it — no amount of browsing news.ycombinator.com produces the call. Once
 * loaded, it queries an Algolia index directly:
 *
 *   POST https://uj5wyc0l7x-dsn.algolia.net/1/indexes/Item_dev/query
 *        ?x-algolia-api-key=...&x-algolia-application-id=...
 *
 * The application id and the search-only api key are the client's, not a
 * session's: they are rendered inline in the search page's HTML and are the
 * same for every visitor. They are also values Algolia customers rotate, so
 * they are harvested per-process rather than pinned in source — a constant
 * copied from a running site reads as permanent and gets debugged as a logic
 * error when it turns over.
 *
 * The harvest runs over direct HTTP rather than through the browser because
 * elimination showed the browser cannot make it: hn.algolia.com serves its
 * document with no `Access-Control-Allow-Origin`, so a fetch issued from a
 * news.ycombinator.com page fails with a bare `TypeError: Failed to fetch`
 * (observed, twice). The page is a public static document that needs no
 * session, which is exactly the case where leaving the browser is legitimate.
 *
 * @module domain-hackernews/algolia
 */

import { DEBUG, rateLimitedFetch } from '@interceptor/shared';

export interface AlgoliaCredentials {
	appId: string;
	apiKey: string;
	/** The DSN host derived from the app id, which is how the SPA addresses it. */
	host: string;
}

/** The search page, whose HTML carries both values inline. */
const SEARCH_PAGE = 'https://hn.algolia.com/';

/**
 * Cached for the process lifetime, because the values are per-client rather
 * than per-request and the harvest is a whole extra round trip to a third
 * party. Cleared on a failed query so a rotation recovers on the next call.
 */
let cached: AlgoliaCredentials | null = null;

export function clearAlgoliaCredentials(): void {
	cached = null;
}

/**
 * Read `appId` and the search-only key out of the search page.
 *
 * Throws rather than falling back to the values observed during discovery. A
 * stale key would produce a 403 from Algolia that reads like a broken route,
 * and the whole point of harvesting is that the answer comes from the site.
 */
export async function getAlgoliaCredentials(): Promise<AlgoliaCredentials> {
	if (cached) return cached;

	const res = await rateLimitedFetch(SEARCH_PAGE);
	if (!res.ok) throw new Error(`hn.algolia.com returned ${res.status} for the credential harvest`);
	const html = await res.text();

	const appId = html.match(/appId:\s*['"]([A-Z0-9]{6,})['"]/)?.[1];
	const apiKey = html.match(/apiKey:\s*['"]([0-9a-f]{32})['"]/)?.[1];
	if (!appId || !apiKey) {
		throw new Error(
			'hn.algolia.com no longer renders appId/apiKey inline — the search client was rebuilt, re-run discovery against it',
		);
	}

	cached = { appId, apiKey, host: `${appId.toLowerCase()}-dsn.algolia.net` };
	DEBUG('hackernews', `algolia credentials harvested: app=${appId}`);
	return cached;
}
