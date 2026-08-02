import { GenericInterceptor } from '@interceptor/browser/shared/interceptor';
import { yahooFinanceInterceptorConfig } from './config';

/** The streaming route needs no captured credential; the REST ones need a crumb. */
export class YahooFinanceInterceptor extends GenericInterceptor {
	constructor() {
		super(yahooFinanceInterceptorConfig);
	}
}
