import { GenericInterceptor } from '@interceptor/browser/shared/interceptor';
import { youtubeInterceptorConfig } from './config';

/** Nothing to harvest: the routes drive the player rather than replaying calls. */
export class YouTubeInterceptor extends GenericInterceptor {
	constructor() {
		super(youtubeInterceptorConfig);
	}
}
