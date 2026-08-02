import type { InterceptorConfig } from '@interceptor/browser/shared/config';

/**
 * Twitch's core data — directory listings, VOD listings, live HLS playback,
 * and anonymous chat — all work over plain HTTP with a public, hardcoded
 * `Client-ID` header (`kimne78kx3ncx6brgo4mv6wki5h1ko`, the value twitch.tv's
 * own web client ships). None of it needs cookies or a browser session, which
 * is why every route below sets `browserRequired: false`.
 *
 * The one gate is Kasada (`k.twitchcdn.net/*\/fp`, `/tl`, and the
 * `gql.twitch.tv/integrity` mutation): cursor-based pagination past the first
 * page of a directory or VOD listing requires a `client-integrity` token
 * computed by Kasada's obfuscated in-page JS. Confirmed session-gated by
 * probing it two ways — see routes.ts's `DirectoryPage_Game` comment — so
 * `requiredHeaders` stays empty rather than naming a header no route can
 * supply. No login flow exists for anonymous browsing, so there is no
 * `loginUrl`/`accountUrl` pair to declare either.
 */
export const twitchInterceptorConfig: InterceptorConfig = {
	domainName: 'twitch',
	interceptPatterns: ['https://www.twitch.tv/**', 'https://gql.twitch.tv/**'],
	requiredHeaders: [],
	baseUrls: ['https://gql.twitch.tv', 'https://usher.ttvnw.net', 'https://api.twitch.tv'],
};
