/**
 * Build Nvidia Interceptor Configuration
 *
 * Captures API traffic from build.nvidia.com and api.ngc.nvidia.com.
 * The plugin's primary value is browserless proxy routes — see routes.ts.
 * The interceptor patterns are kept as a hint for the dashboard's traffic
 * viewer when a session is attached.
 */

import type { InterceptorConfig } from '@interceptor/browser/shared/config';

export const buildNvidiaInterceptorConfig: InterceptorConfig = {
	domainName: 'build-nvidia',

	interceptPatterns: [
		'https://build.nvidia.com/api/**',
		'https://api.ngc.nvidia.com/v2/**',
		'https://integrate.api.nvidia.com/v1/**',
	],

	requiredHeaders: [],

	baseUrls: ['https://build.nvidia.com'],
};
