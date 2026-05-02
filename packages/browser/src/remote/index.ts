/**
 * Remote browser streaming module exports.
 * @module browser/remote
 */

export { BrowserLifecycleManager } from './browser-manager';
export {
	type CapturedScript,
	type CaptureHandler,
	CdpScriptControl,
	type FetchCaptureOptions,
	type InitScriptHandle,
} from './cdp-script-control';
export { FingerprintController } from './fingerprint-controller';
export { browserLogger } from './logger';
export { PERSONAS, type PoolPersona, pickPersona } from './personas';
export { BrowserPool, type BrowserPoolConfig, type PersonaAttacher } from './pool';
export {
	cleanProfile,
	createProfile,
	deleteProfile,
	getOrCreateProfilePath,
	getProfilePath,
	getProfilesDir,
	listProfiles,
	type ProfileInfo,
	profileExists,
	validateProfileName,
} from './profiles';
export {
	connectBrowserRateLimiter,
	type FrameCallback,
	type FrameData,
	RemoteBrowserService,
	type StreamConfig,
} from './service';
