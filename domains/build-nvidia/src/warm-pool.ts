/**
 * BuildNvidiaWarmPool — N pool browsers, each with its own persona, each
 * with one warm-mint page. Round-robin mint dispatch across the pool.
 *
 * The pool sits on top of `BrowserPool` (packages/browser): it boots N
 * `RemoteBrowserService` instances in parallel, each with a different
 * profile dir + `PoolPersona`, then lazily warms one mint page per
 * browser on first use.
 *
 * Why per-browser warm pages instead of per-page personas in one browser:
 *   - Init scripts on a CDP target apply to ALL frames inheriting from
 *     that target. We can't scope an init script to one of N tabs in the
 *     same browser context — they'd all see the same persona.
 *   - Profile dirs give each browser its own cookies, IndexedDB,
 *     localStorage. hCaptcha can fingerprint persistent storage state;
 *     separate dirs makes each pool member a distinct "user".
 *   - This matches the chatgpt-toolkit pattern (commit 73d7fd7).
 */

import {
	BrowserPool,
	type PersonaAttacher,
	type PoolPersona,
	pickPersona,
	type RemoteBrowserService,
} from '@interceptor/browser/remote';

import type { BuildNvidiaPersona } from './fingerprint-script';
import { mintViaWarmPage } from './warm-mint';

/**
 * Convert a `PoolPersona` (chatgpt-toolkit shape, browser-package-owned)
 * into the build-nvidia persona shape used by the fingerprint init script.
 */
function poolPersonaToBuildNvidia(p: PoolPersona): BuildNvidiaPersona {
	return {
		userAgent: p.userAgent,
		platform: p.browser.hardware.platform,
		vendor: p.browser.hardware.vendor,
		language: p.language,
		languages: p.languages,
		hardwareConcurrency: p.browser.hardware.hardwareConcurrency,
		deviceMemory: p.browser.hardware.deviceMemory ?? 8,
		webglVendor: p.browser.webgl.vendor,
		webglRenderer: p.browser.webgl.renderer,
		osName: p.browser.hardware.platform.startsWith('Mac')
			? 'macOS'
			: p.browser.hardware.platform.startsWith('Win')
				? 'Windows'
				: 'Linux',
		screen: p.browser.screen,
	};
}

/**
 * `PersonaAttacher` implementation that pre-arms a pool browser with
 * build-nvidia's fingerprint script before any navigation. We do NOT
 * also warm the mint page here — warm-up happens lazily on first
 * `mint()` call so cold start stays fast.
 */
class BuildNvidiaPersonaAttacher implements PersonaAttacher {
	private readonly attached = new WeakMap<object, BuildNvidiaPersona>();

	async attach(browser: RemoteBrowserService, persona: PoolPersona): Promise<void> {
		const bn = poolPersonaToBuildNvidia(persona);
		this.attached.set(browser as unknown as object, bn);
	}

	personaFor(browser: RemoteBrowserService): BuildNvidiaPersona | undefined {
		return this.attached.get(browser as unknown as object);
	}
}

export interface BuildNvidiaWarmPoolConfig {
	size: number;
	headless?: boolean;
}

export interface MintResult {
	token: string;
	persona: string;
	browserIndex: number;
	durationMs: number;
}

let singleton: BuildNvidiaWarmPool | null = null;

export class BuildNvidiaWarmPool {
	private readonly pool: BrowserPool;
	private readonly attacher = new BuildNvidiaPersonaAttacher();
	private readonly browserIndex = new WeakMap<object, number>();
	private readonly browserPersona = new WeakMap<object, string>();
	private started = false;

	constructor(private readonly config: BuildNvidiaWarmPoolConfig) {
		this.pool = new BrowserPool({
			size: config.size,
			browserConfig: { headless: config.headless ?? true },
			personaAttacher: this.attacher,
		});
	}

	static getInstance(config: BuildNvidiaWarmPoolConfig): BuildNvidiaWarmPool {
		if (!singleton) singleton = new BuildNvidiaWarmPool(config);
		return singleton;
	}

	get size(): number {
		return this.config.size;
	}

	async start(): Promise<void> {
		if (this.started) return;
		await this.pool.start();
		// Index browsers so debug callers can see which slot served them.
		this.pool.all().forEach((b, i) => {
			this.browserIndex.set(b as unknown as object, i);
			this.browserPersona.set(b as unknown as object, pickPersona(i).name);
		});
		this.started = true;
	}

	/**
	 * Round-robin mint with per-browser serialization. Each browser's warm
	 * page is created lazily on its first mint. Returns the token along
	 * with which slot served the request — useful for diagnostics.
	 */
	async mint(timeoutMs = 30_000): Promise<MintResult> {
		if (!this.started) throw new Error('BuildNvidiaWarmPool: start() first');
		const t0 = Date.now();
		const result = await this.pool.withSerialized(async (browser) => {
			const persona = this.attacher.personaFor(browser);
			const token = await mintViaWarmPage(browser, { persona, timeoutMs });
			const idx = this.browserIndex.get(browser as unknown as object) ?? -1;
			const personaName = this.browserPersona.get(browser as unknown as object) ?? 'unknown';
			return { token, browserIndex: idx, persona: personaName };
		});
		return { ...result, durationMs: Date.now() - t0 };
	}

	stats(): {
		started: boolean;
		size: number;
		slots: Array<{ index: number; persona: string | null; inflight: number }>;
	} {
		return {
			started: this.started,
			size: this.config.size,
			slots: this.pool.stats(),
		};
	}
}
