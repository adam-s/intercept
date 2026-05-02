/**
 * Build Nvidia Domain Plugin
 *
 * Provides API interception and proxy routes for build.nvidia.com.
 *
 * @module domain-build-nvidia
 */

import type { DomainPlugin } from '@interceptor/browser/handler/domain-loader';
import { buildNvidiaInterceptorConfig } from './config';
import { BuildNvidiaInterceptor } from './interceptor';
import { routes } from './routes';

export const plugin: DomainPlugin = {
	domainName: 'build-nvidia',
	config: buildNvidiaInterceptorConfig,
	routes,

	createInterceptor: () => new BuildNvidiaInterceptor(),

	detectLoginPage: (url: string) => url.includes('build.nvidia.com/login'),

	onVerified: (result) => ({
		type: 'build-nvidia_verified',
		accountNumber: result.accountNumber,
	}),

	onVerificationFailed: (error) => ({
		type: 'build-nvidia_verification_failed',
		error,
	}),

	onLoginDetected: () => ({
		type: 'build-nvidia_login_page_detected',
	}),
};

export { buildNvidiaInterceptorConfig } from './config';
export { BuildNvidiaInterceptor } from './interceptor';
export { routes } from './routes';
