import { GenericInterceptor } from '@interceptor/browser/shared/interceptor';
import { hackerNewsInterceptorConfig } from './config';

/**
 * No domain-specific header capture is needed — see config.ts. This class
 * exists only because `GenericInterceptor` is abstract; the base
 * implementation is sufficient for a public, cookie-free surface.
 */
export class HackerNewsInterceptor extends GenericInterceptor {
	constructor() {
		super(hackerNewsInterceptorConfig);
	}
}
