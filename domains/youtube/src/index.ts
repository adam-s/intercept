import type { DomainPlugin } from '@interceptor/browser/handler/domain-loader';
import { youtubeInterceptorConfig } from './config';
import { YouTubeInterceptor } from './interceptor';
import { routes } from './routes';

export const plugin: DomainPlugin = {
	domainName: 'youtube',
	config: youtubeInterceptorConfig,
	routes,
	createInterceptor: () => new YouTubeInterceptor(),
};

export { routes } from './routes';
