/**
 * Reddit Domain Plugin
 *
 * Public, read-only content (feeds, posts, comments, video renditions) — no
 * login flow, so verifyCredentials/detectLoginPage/onVerified are left
 * unset. See routes.ts for why every route goes through the connected
 * browser instead of a captured-header handshake.
 *
 * @module domain-reddit/index
 */

import type { DomainPlugin } from '@interceptor/browser/handler/domain-loader';
import { redditInterceptorConfig } from './config';
import { RedditInterceptor } from './interceptor';
import { routes } from './routes';

export const plugin: DomainPlugin = {
	domainName: 'reddit',
	config: redditInterceptorConfig,
	routes,
	createInterceptor: () => new RedditInterceptor(),
};

export { redditInterceptorConfig } from './config';
export { RedditInterceptor } from './interceptor';
export { routes } from './routes';
