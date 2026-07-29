/**
 * @interceptor/browser/shared — Generic domain-agnostic classes
 *
 * Shared base classes for multi-domain support:
 * - GenericInterceptor: Base class for all domain interceptors
 * - GenericSessionManager: Centralized session/header management
 * - Shared types and configs
 *
 * @module browser/shared
 */

export {
	classifyEntry,
	classifyPage,
	type EncodingType,
	type PageClassification,
	type TrafficClassification,
	type TrafficEntry,
	type TransportType,
} from './classify-transport';
export type { InterceptorConfig, VerificationResult } from './config';
export { GenericInterceptor } from './interceptor';
export type { MainWorldOptions, MainWorldPage } from './main-world';
export { evaluateInMainWorld } from './main-world';
export { GenericSessionManager } from './session-manager';
export type {
	InterceptedRequest,
	InterceptedResponse,
	InterceptionCallback,
	SessionStatus,
} from './types';
