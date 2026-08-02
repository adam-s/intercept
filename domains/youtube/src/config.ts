import type { InterceptorConfig } from '@interceptor/browser/shared/config';

/**
 * YouTube's media path cannot be replayed, so the browser is not a convenience
 * here — it is the only client. Media negotiates over `/videoplayback` with UMP
 * framing rather than being handed out as a URL, and the player response served
 * to a page carries no format URL at all: no `url`, no `signatureCipher`, just
 * an itag and a length. A captured request cannot be replayed into a stream,
 * and reconstructing the negotiation means reimplementing a protocol that
 * changes without notice.
 *
 * What the page has is a working player. Driving it is both the cheapest path
 * and the honest one.
 */
export const youtubeInterceptorConfig: InterceptorConfig = {
	domainName: 'youtube',
	interceptPatterns: ['https://www.youtube.com/**', 'https://*.googlevideo.com/**'],
	requiredHeaders: [],
	baseUrls: ['https://www.youtube.com'],
};
