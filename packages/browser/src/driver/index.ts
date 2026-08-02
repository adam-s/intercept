/**
 * @interceptor/browser/driver — engine selection behind one interface
 *
 * `patchright` is the default because it is the engine this framework is proven
 * on and the only one with CDP, which the live browser view and raw input
 * injection still need. `camoufox` is opted into per target, where its
 * engine-level fingerprint is worth the memory and the loss of CDP.
 *
 * Which to choose, and what each costs: [docs/BROWSER-DRIVERS.md](../../../../docs/BROWSER-DRIVERS.md).
 *
 * @module browser/driver
 */

import { camoufoxDriver } from './camoufox-driver.js';
import { patchrightDriver } from './patchright-driver.js';
import type { BrowserDriver, DriverKind } from './types.js';

export { camoufoxDriver } from './camoufox-driver.js';
export {
	captureDecision,
	header,
	isDataContentType,
	isTelemetry,
	parseBody,
} from './capture-filter.js';
export {
	DRAIN_SOURCE,
	EGRESS_GLOBAL,
	type EgressEvent,
	type EgressKind,
	INSTRUMENT_LIMITS,
	INSTRUMENT_SOURCE,
	UNINSTALL_SOURCE,
} from './instrument.js';
export {
	isDestructive,
	runSweep,
	SWEEP_LIMITS,
	type SweepAction,
	type SweepLimits,
	sweepPlan,
} from './interaction-sweep.js';
export {
	buildManifest,
	deriveTransports,
	MANIFEST_LIMITS,
	type ManifestRow,
	parseTarget,
	renderManifest,
	renderTransports,
	shapeOfBody,
	type TransportVerdict,
	templateSegment,
} from './manifest.js';
export { patchrightDriver } from './patchright-driver.js';
export {
	drainEgressEvents,
	installEgressInstrument,
	removeEgressInstrument,
	startTrafficCapture,
} from './traffic-capture.js';
export type {
	BrowserDriver,
	CapturedRequest,
	CapturedResponse,
	DriverCapabilities,
	DriverKind,
	DriverLaunchOptions,
	DriverPage,
	DriverSession,
	NetworkCaptureCallback,
} from './types.js';
export { DriverCapabilityError } from './types.js';

const DRIVERS: Record<DriverKind, BrowserDriver> = {
	patchright: patchrightDriver,
	camoufox: camoufoxDriver,
};

/** The engine used when a target does not ask for one. */
export const DEFAULT_DRIVER: DriverKind = 'patchright';

/** Every registered driver kind. */
export function listDrivers(): DriverKind[] {
	return Object.keys(DRIVERS) as DriverKind[];
}

/**
 * Get a driver by kind.
 *
 * Throws on an unknown kind rather than falling back to the default: a typo in
 * a domain's config that silently ran the wrong engine would make every
 * subsequent bot-protection result meaningless.
 */
export function getDriver(kind: DriverKind = DEFAULT_DRIVER): BrowserDriver {
	const driver = DRIVERS[kind];
	if (!driver) {
		throw new Error(`Unknown browser driver "${kind}". Available: ${listDrivers().join(', ')}.`);
	}
	return driver;
}

/**
 * Get a driver and confirm its engine is actually installed.
 *
 * Prefer this at a call site that is about to launch, so a missing engine
 * reports itself before any target is touched.
 */
export async function requireDriver(kind: DriverKind = DEFAULT_DRIVER): Promise<BrowserDriver> {
	const driver = getDriver(kind);
	const { available, reason } = await driver.isAvailable();
	if (!available) {
		throw new Error(`Browser driver "${kind}" is not available: ${reason}`);
	}
	return driver;
}
