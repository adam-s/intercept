/**
 * Reddit Interceptor Config
 *
 * @module domain-reddit/config
 */

import type { InterceptorConfig } from '@interceptor/browser/shared/config';

export const redditInterceptorConfig: InterceptorConfig = {
	domainName: 'reddit',
	// Discovery found six data-bearing transports, three of them on
	// `/svc/shreddit/**`: HTML fragments for feeds and profiles, a
	// form-encoded POST for comment continuation, and an operation-name
	// GraphQL gateway. The `.json` gateway and the v.redd.it media host sit
	// on the same origin family and are included so their traffic is captured
	// too.
	//
	// There is no bearer-token or API-key *header* to capture: what the
	// session carries is a `csrf_token` cookie the connected browser already
	// holds, and the realtime bearer is minted from it per call rather than
	// harvested (see routes.ts, route 9). So requiredHeaders stays empty and
	// routes never wait on a captured-header handshake.
	interceptPatterns: [
		'https://www.reddit.com/svc/**',
		'https://www.reddit.com/**',
		'https://v.redd.it/**',
	],
	requiredHeaders: [],
	baseUrls: ['https://www.reddit.com'],
};
