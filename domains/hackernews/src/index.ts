/**
 * Hacker News Domain Plugin
 *
 * The public surface (listings, item threads, user profiles, RSS) needs no
 * session at all — see routes.ts for the discovery summary. There is
 * nothing to verify or capture, so this plugin omits verifyCredentials,
 * detectLoginPage, and the WebSocket event hooks entirely; all three are
 * optional on DomainPlugin.
 *
 * @module domain-hackernews/index
 */

import type { DomainPlugin } from '@interceptor/browser/handler/domain-loader';
import { hackerNewsInterceptorConfig } from './config';
import { HackerNewsInterceptor } from './interceptor';
import { routes } from './routes';

export const plugin: DomainPlugin = {
	domainName: 'hackernews',
	config: hackerNewsInterceptorConfig,
	routes,
	createInterceptor: () => new HackerNewsInterceptor(),
};

export { hackerNewsInterceptorConfig } from './config';
export { HackerNewsInterceptor } from './interceptor';
export { routes } from './routes';
