import type { InterceptorConfig } from '@interceptor/browser/shared/config';

/**
 * Hacker News (news.ycombinator.com) is a fully server-rendered site with no
 * bot protection. Direct HTTP reaches every route the front end reaches
 * (confirmed during discovery: curl with a plain User-Agent gets the same
 * 200 responses the browser gets, cookie-free). `requiredHeaders` is empty
 * because there is no auth handshake to capture for the anonymous, public
 * surface these routes cover — voting, comment collapsing, and story hiding
 * are real client-side transports (see routes.ts header comment) but require
 * a logged-in account this discovery run had no credentials for.
 */
export const hackerNewsInterceptorConfig: InterceptorConfig = {
	domainName: 'hackernews',
	interceptPatterns: ['https://news.ycombinator.com/**'],
	requiredHeaders: [],
	baseUrls: ['https://news.ycombinator.com'],
};
