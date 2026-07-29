import { GenericInterceptor } from '@interceptor/browser/shared/interceptor';
import { twitchInterceptorConfig } from './config';

/** Nothing to harvest: every route calls the public GraphQL/HLS/chat surface directly. */
export class TwitchInterceptor extends GenericInterceptor {
	constructor() {
		super(twitchInterceptorConfig);
	}
}
