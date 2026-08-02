import type { DomainPlugin } from '@interceptor/browser/handler/domain-loader';
import { twitchInterceptorConfig } from './config';
import { TwitchInterceptor } from './interceptor';
import { routes } from './routes';

export const plugin: DomainPlugin = {
	domainName: 'twitch',
	config: twitchInterceptorConfig,
	routes,
	createInterceptor: () => new TwitchInterceptor(),
};

export { routes } from './routes';
