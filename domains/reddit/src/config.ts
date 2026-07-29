/**
 * Reddit Interceptor Config
 *
 * @module domain-reddit/config
 */

import type { InterceptorConfig } from '@interceptor/browser/shared/config';

export const redditInterceptorConfig: InterceptorConfig = {
	domainName: 'reddit',
	// Discovery showed the site's data transport is `/svc/shreddit/**` — HTML
	// fragments (feeds, comments, search) served to the page's own faceplate
	// loaders. There is no bearer-token or API-key header to capture: the
	// session is carried entirely in cookies the connected browser already
	// holds, so requiredHeaders stays empty and routes call browser.browserFetch
	// directly rather than waiting on a captured-header handshake.
	interceptPatterns: ['https://www.reddit.com/svc/**', 'https://www.reddit.com/**'],
	requiredHeaders: [],
	baseUrls: ['https://www.reddit.com'],
};
