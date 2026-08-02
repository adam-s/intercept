import type { DomainPlugin } from '@interceptor/browser/handler/domain-loader';
import { yahooFinanceInterceptorConfig } from './config';
import { YahooFinanceInterceptor } from './interceptor';
import { routes } from './routes';

export const plugin: DomainPlugin = {
	domainName: 'yahoofinance',
	config: yahooFinanceInterceptorConfig,
	routes,
	createInterceptor: () => new YahooFinanceInterceptor(),
};

export { decodePricing } from './protobuf';
export { routes } from './routes';
