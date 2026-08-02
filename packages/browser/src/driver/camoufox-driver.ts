/**
 * Camoufox Driver — Firefox
 *
 * Camoufox is Firefox with its fingerprint set in C++, below the reach of any
 * page script. That is the difference from spoofing over CDP from JavaScript:
 * an override installed by script is real but discoverable, while an engine
 * that reports different values has nothing to discover.
 *
 * Two settings here are load-bearing and easy to get wrong:
 *
 *  1. **Never true headless.** It trips Cloudflare regardless of engine. Linux
 *     runs a virtual display; a developer machine runs headed. This driver
 *     refuses `headless: true` rather than running in a mode that reliably
 *     fails — a refusal is debuggable, an unexplained challenge is not.
 *
 *  2. **Pin the persona OS whenever a profile persists.** A clearance cookie is
 *     bound to the user agent that earned it. Camoufox randomizes persona OS
 *     per launch, so an unpinned persistent profile silently invalidates its
 *     own cookie and re-challenges every run. Pinning stops the challenge
 *     firing at all, which is better than solving it. This driver defaults the
 *     pin to the host OS when a profile directory is given.
 *
 * Version coupling is per-build and brittle: a camoufox release matches one
 * playwright-core range, and a mismatch surfaces as a crash rather than a
 * version error. The pin lives in package.json, where it can be tested.
 *
 * Firefox quirks that cost real debugging time elsewhere and are handled here
 * or documented at the call site: location-less `pageerror` events are noise;
 * `NS_BINDING_ABORTED` on navigation wants `waitUntil: 'commit'` plus a settle;
 * frames detach mid-query, so element lookups need a guard.
 *
 * @module browser/driver/camoufox-driver
 */

import { platform } from 'node:os';
import { DEBUG } from '@interceptor/shared';
import { startTrafficCapture } from './traffic-capture.js';
import type {
	BrowserDriver,
	DriverCapabilities,
	DriverLaunchOptions,
	DriverPage,
	DriverSession,
	NetworkCaptureCallback,
} from './types.js';

const CAPABILITIES: DriverCapabilities = {
	// Firefox speaks Juggler; Playwright exposes no CDP session for it.
	cdp: false,
	engineLevelFingerprint: true,
	pinnableOs: true,
	// Technically available, deliberately refused. See the docblock.
	trueHeadless: false,
	// Firefox under Playwright evaluates in the page's own world, so page
	// globals are directly readable — the opposite of the Chromium path.
	isolatedEvaluateWorld: false,
};

/** Persona OS matching the host, so a pinned profile looks native. */
export function defaultPersonaOs(hostPlatform: string = platform()): 'windows' | 'macos' | 'linux' {
	if (hostPlatform === 'darwin') return 'macos';
	if (hostPlatform === 'win32') return 'windows';
	return 'linux';
}

/**
 * Resolve the headless setting for camoufox.
 *
 * Returns `'virtual'` on Linux (camoufox's built-in virtual display) and
 * `false` elsewhere. Never `true`.
 */
export function resolveHeadless(
	requested: boolean | undefined,
	hostPlatform: string = platform(),
): 'virtual' | false {
	if (requested === true && hostPlatform !== 'linux') {
		throw new Error(
			'camoufox refuses true headless: it trips bot protection regardless of engine. ' +
				'On Linux it runs a virtual display automatically; elsewhere run headed. ' +
				'Pass headless: false, or use the patchright driver when true headless is required.',
		);
	}
	return hostPlatform === 'linux' ? 'virtual' : false;
}

/** Launch config for camoufox, derived from the engine-neutral options. Pure. */
export function buildLaunchConfig(
	options: DriverLaunchOptions,
	hostPlatform: string = platform(),
): Record<string, unknown> {
	const persistent = Boolean(options.profileDir);
	return {
		headless: resolveHeadless(options.headless, hostPlatform),
		// Unpinned + persistent silently invalidates the saved clearance cookie
		// on every launch, so the pin defaults on whenever a profile persists.
		...(options.os || persistent ? { os: options.os ?? defaultPersonaOs(hostPlatform) } : {}),
		...(options.profileDir ? { user_data_dir: options.profileDir, persistent_context: true } : {}),
		...(options.args?.length ? { args: options.args } : {}),
		...(options.timeout ? { timeout: options.timeout } : {}),
		// Cursor movement and timing that reads as a person rather than a script.
		humanize: true,
	};
}

class CamoufoxSession implements DriverSession {
	readonly kind = 'camoufox' as const;
	readonly capabilities = CAPABILITIES;

	constructor(private readonly context: { newPage(): Promise<unknown>; close(): Promise<void> }) {}

	async newPage(): Promise<DriverPage> {
		const page = (await this.context.newPage()) as DriverPage;
		// Firefox reports location-less pageerrors for ordinary page script
		// noise. Left unhandled they surface as unhandled rejections that look
		// like framework faults.
		page.on('pageerror', ((err: { message?: string }) => {
			DEBUG('driver', `firefox pageerror (ignored): ${err?.message ?? String(err)}`);
		}) as never);
		return page;
	}

	async startTrafficCapture(
		page: DriverPage,
		onCapture: NetworkCaptureCallback,
	): Promise<() => void> {
		return startTrafficCapture(page, onCapture);
	}

	async close(): Promise<void> {
		await this.context.close();
	}
}

export const camoufoxDriver: BrowserDriver = {
	kind: 'camoufox',
	capabilities: CAPABILITIES,

	async isAvailable() {
		try {
			await import('camoufox-js');
		} catch (err) {
			return {
				available: false,
				reason:
					'camoufox-js is not installed. Install it and fetch the browser build ' +
					`(it is a large download, so it is not part of a default install): ${String(err)}`,
			};
		}
		try {
			await import('playwright-core');
			return { available: true };
		} catch (err) {
			return {
				available: false,
				reason: `camoufox-js needs playwright-core as a peer dependency: ${String(err)}`,
			};
		}
	},

	async launch(options: DriverLaunchOptions = {}): Promise<DriverSession> {
		const { launchOptions } = (await import('camoufox-js')) as {
			launchOptions: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
		};
		const { firefox } = await import('playwright-core');

		const config = buildLaunchConfig(options);
		DEBUG('driver', `launching camoufox ${JSON.stringify({ ...config, humanize: undefined })}`);

		// camoufox-js resolves its binary, fingerprint, and preferences into
		// Playwright launch options; playwright-core does the launching.
		const resolved = await launchOptions(config);

		const context = options.profileDir
			? await firefox.launchPersistentContext(options.profileDir, resolved as never)
			: await (await firefox.launch(resolved as never)).newContext();

		return new CamoufoxSession(context as never);
	},
};
