import type { InterceptorConfig } from '@interceptor/browser/shared/config';

/**
 * The price socket needs no session at all — no cookie, no crumb — which is
 * unusual enough to be worth stating: elimination proved it, and a route that
 * reached for the browser anyway would pay for a session it does not need.
 * The REST endpoints are the opposite and take a crumb harvested from a page.
 */
export const yahooFinanceInterceptorConfig: InterceptorConfig = {
	domainName: 'yahoofinance',
	interceptPatterns: ['https://finance.yahoo.com/**', 'https://query*.finance.yahoo.com/**'],
	requiredHeaders: [],
	baseUrls: ['https://finance.yahoo.com'],
};
