/**
 * Build Nvidia Interceptor
 *
 * Extends GenericInterceptor for build.nvidia.com API traffic capture.
 */

import { GenericInterceptor } from '@interceptor/browser/shared/interceptor';
import { buildNvidiaInterceptorConfig } from './config';

export class BuildNvidiaInterceptor extends GenericInterceptor {
	constructor() {
		super(buildNvidiaInterceptorConfig);
	}
}
