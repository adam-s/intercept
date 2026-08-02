/**
 * BrowserPool — N RemoteBrowserService instances, each with its own
 * userDataDir (so each gets its own `oai-did` cookie and counts as a
 * distinct device against ChatGPT's per-device rate limit).
 *
 * Optionally each browser also gets a distinct persona (UA, screen,
 * WebGL, languages, timezone) attached via CDP before page navigation.
 * Combined with separate profile dirs, each pool member looks like a
 * fully independent device class.
 *
 * Strategy:
 *   - Round-robin pick.
 *   - Per-browser mutex: only one in-flight call per profile at a time.
 *     (chatgpt's anti-abuse flags two too-tight prepare/conversation
 *     pairs from the same `oai-did` as "Unusual activity".)
 *   - Cold start: all browsers launch + navigate + persona-attach in
 *     parallel, so total bootstrap is ≈ 12s regardless of N.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type PoolPersona, pickPersona } from './personas';
import { RemoteBrowserService, type StreamConfig } from './service';

/**
 * Subset of `chatgpt/fingerprint`'s `ChatGPTScriptInterceptor` we depend
 * on. Defining the interface here lets the browser/ tree stay free of
 * chatgpt/ imports — the toolkit's server.ts wires the real interceptor
 * factory in.
 */
export interface PersonaAttacher {
	attach(browser: RemoteBrowserService, persona: PoolPersona): Promise<void>;
}

export interface BrowserPoolConfig {
	/** Number of browsers in the pool. Each gets its own profile dir. */
	size: number;
	/** Stream config applied to every browser (headless, viewport, etc.). */
	browserConfig: Omit<StreamConfig, 'userDataDir'>;
	/**
	 * Resolves the userDataDir path for the i-th profile (0-indexed).
	 * Default: i=0 → ~/.chatgpt-toolkit/profile (preserves the seeded
	 * legacy path), i>0 → ~/.chatgpt-toolkit/profile-{i+1}.
	 */
	profilePath?: (index: number) => string;
	/** Optional: URL to navigate each browser to after start. */
	navigateTo?: string;
	/** ms to wait after navigate for hydration (per browser, parallel). */
	hydrateMs?: number;
	/**
	 * Optional persona attacher. When set, each pool browser gets a
	 * distinct persona attached via CDP before navigation. Pool index i
	 * receives `pickPersona(i)`.
	 */
	personaAttacher?: PersonaAttacher;
}

interface Slot {
	browser: RemoteBrowserService;
	persona: PoolPersona | undefined;
	/** Promise chain for serializing calls on this browser. */
	tail: Promise<unknown>;
	inflight: number;
}

export class BrowserPool {
	private slots: Slot[] = [];
	private cursor = 0;
	private started = false;

	constructor(private readonly config: BrowserPoolConfig) {
		if (config.size < 1) throw new Error('BrowserPool: size must be ≥ 1');
	}

	get size(): number {
		return this.config.size;
	}

	/**
	 * Boot all browsers in parallel. Each gets its own profile dir +
	 * (optionally) its own persona. Resolves once every browser has
	 * navigated + hydrated.
	 */
	async start(): Promise<void> {
		if (this.started) return;
		const resolve = this.config.profilePath ?? defaultProfilePath;

		// Pre-create profile dirs synchronously so launches don't race.
		for (let i = 0; i < this.config.size; i++) {
			const dir = resolve(i);
			if (!existsSync(dir)) {
				mkdirSync(dir, { recursive: true });
				console.log(`[pool] Created profile dir: ${dir}`);
			}
		}

		this.slots = Array.from({ length: this.config.size }, (_, i) => {
			const persona = this.config.personaAttacher ? pickPersona(i) : undefined;
			const browser = new RemoteBrowserService({
				...this.config.browserConfig,
				userDataDir: resolve(i),
			});
			return { browser, persona, tail: Promise.resolve(), inflight: 0 };
		});

		// Launch + (optionally attach persona) + navigate in parallel.
		const hydrateMs = this.config.hydrateMs ?? 12_000;
		await Promise.all(
			this.slots.map(async (slot, i) => {
				console.log(
					`[pool] Launching browser ${i + 1}/${this.config.size}${slot.persona ? ` (persona: ${slot.persona.name})` : ''}…`,
				);
				await slot.browser.start(() => {});
				if (this.config.personaAttacher && slot.persona) {
					await this.config.personaAttacher.attach(slot.browser, slot.persona);
				}
				if (this.config.navigateTo) {
					await slot.browser.navigate(this.config.navigateTo);
				}
			}),
		);
		console.log(`[pool] Hydrating Sentinel scripts (${hydrateMs}ms)…`);
		await new Promise((r) => setTimeout(r, hydrateMs));

		this.started = true;
		console.log(`[pool] All ${this.config.size} browsers ready.`);
	}

	/**
	 * Round-robin pick. O(1), synchronous — safe to call from concurrent
	 * request handlers. Cursor is shared so concurrent picks fan out.
	 *
	 * Returns the underlying browser. Note: callers that want to enforce
	 * the per-profile mutex (only one in-flight call per browser at a
	 * time) should use `withSerialized()` instead.
	 */
	pick(): RemoteBrowserService {
		if (!this.started) throw new Error('BrowserPool: pick() called before start()');
		const idx = this.cursor++ % this.slots.length;
		return this.slots[idx].browser;
	}

	/**
	 * Pick a browser AND wrap the caller's work so it runs serially
	 * relative to other `withSerialized` calls on the same browser.
	 * Use this for chatgpt /conversation submits to avoid the per-device
	 * "Unusual activity" 403 that fires when two prepare/conversation
	 * pairs go out from one `oai-did` within milliseconds.
	 *
	 * Distribution is round-robin on call ENTRY (so concurrent requests
	 * fan across the pool), but each browser's tail-promise serializes
	 * the actual work.
	 */
	async withSerialized<R>(fn: (b: RemoteBrowserService) => Promise<R>): Promise<R> {
		if (!this.started) throw new Error('BrowserPool: withSerialized called before start()');
		const idx = this.cursor++ % this.slots.length;
		const slot = this.slots[idx];
		slot.inflight++;
		const next = slot.tail.then(() => fn(slot.browser));
		// Replace the tail with a resolved promise so subsequent callers
		// chain off our completion (regardless of resolve/reject).
		slot.tail = next.catch(() => undefined);
		try {
			return await next;
		} finally {
			slot.inflight--;
		}
	}

	/** All browsers, for diagnostics. */
	all(): readonly RemoteBrowserService[] {
		return this.slots.map((s) => s.browser);
	}

	/** Inflight + queued counts per slot, for /health-style introspection. */
	stats(): Array<{ index: number; persona: string | null; inflight: number }> {
		return this.slots.map((s, i) => ({
			index: i,
			persona: s.persona?.name ?? null,
			inflight: s.inflight,
		}));
	}
}

function defaultProfilePath(index: number): string {
	const root = join(homedir(), '.chatgpt-toolkit');
	return index === 0 ? join(root, 'profile') : join(root, `profile-${index + 1}`);
}
