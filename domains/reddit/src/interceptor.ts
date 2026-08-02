/**
 * Reddit Request Interceptor
 *
 * Reddit needs no captured-header handshake (see config.ts) — this class
 * exists only because DomainPlugin.createInterceptor requires a
 * GenericInterceptor instance. It attaches with an empty requiredHeaders set
 * and never blocks route traffic on it.
 *
 * @module domain-reddit/interceptor
 */

import { GenericInterceptor } from '@interceptor/browser/shared/interceptor';
import { redditInterceptorConfig } from './config';

export class RedditInterceptor extends GenericInterceptor {
	constructor() {
		super(redditInterceptorConfig);
	}
}
