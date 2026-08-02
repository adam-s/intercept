/**
 * CdpScriptControl
 *
 * Single surface for installing main-world init scripts and capturing
 * upstream script bodies on a remote-browser session. Replaces the
 * scattered `page.addInitScript` + `page.route()` calls that domain plugins
 * used to make individually.
 *
 * INIT SCRIPTS — load-bearing path is `context.addInitScript(source)` plus
 * `page.addInitScript(source)` on the pre-existing root page. Patchright
 * forwards both to `Page.addScriptToEvaluateOnNewDocument` on the session
 * that drives each page's renderer, which is what Chromium needs to apply
 * the script to subsequent navigations and to subframes (Chromium
 * auto-propagates main-world init scripts to OOPIFs).
 *
 * Why not "raw CDP only"? A CDPSession created via
 * `context.newCDPSession(page)` happily accepts
 * `Page.addScriptToEvaluateOnNewDocument` and returns an identifier — but
 * Chromium scopes the resulting init-script list to that session. The
 * page's actual rendering session (the one Patchright owns internally)
 * does NOT see the script, and your override silently never runs.
 * Patchright's `addInitScript` injects the source verbatim with no JS
 * wrapper, so going through it costs us nothing visible to in-page code.
 *
 * Scripts run in MAIN world. Patchright's `page.evaluate` uses an
 * ISOLATED world by default — your `Object.defineProperty(navigator, …)`
 * overrides are real but invisible from the evaluator. Use a DOM-side
 * marker (e.g. `documentElement.setAttribute('data-fp-installed', '1')`)
 * to confirm installation from outside.
 *
 * SCRIPT BODY CAPTURE — `Fetch.enable` + `Fetch.requestPaused` on our own
 * CDPSession works fine for read-only capture of upstream script bodies.
 * Bytes are NOT rewritten — the goal is to control the environment, not
 * the upstream bundle (Turnstile bundles XOR-decrypt and may self-check).
 *
 * USAGE
 * ─────
 *   const control = new CdpScriptControl();
 *   await control.attach(context, page);
 *   const handle = await control.registerInitScript(personaScript);
 *   const stop = await control.captureScripts({ urlPattern: '*turnstile*' },
 *     ({ url, body }) => fs.writeFileSync(`/tmp/${slug(url)}.js`, body));
 *   ...
 *   await stop();
 *   await control.unregisterInitScript(handle);
 *   await control.detach();
 *
 * @module browser/remote/cdp-script-control
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { BrowserContext, CDPSession, Page } from 'patchright';

// ─── Types ────────────────────────────────────────────────────────────────

export interface InitScriptHandle {
	readonly id: string;
}

export interface CapturedScript {
	url: string;
	method: string;
	frameId: string;
	resourceType: string;
	responseStatusCode: number;
	responseHeaders: Record<string, string>;
	body: string;
	base64Encoded: boolean;
}

export interface FetchCaptureOptions {
	/** CDP url pattern, e.g. `*challenges.cloudflare.com*` or `*sentinel*`. */
	urlPattern: string;
	/** Defaults to 'Script'. */
	resourceType?:
		| 'Document'
		| 'Stylesheet'
		| 'Image'
		| 'Media'
		| 'Font'
		| 'Script'
		| 'XHR'
		| 'Fetch'
		| 'EventSource'
		| 'WebSocket'
		| 'Manifest'
		| 'Other';
}

export type CaptureHandler = (s: CapturedScript) => void | Promise<void>;

/**
 * Mutate a script body before it reaches the page. Return:
 *   - `null` to skip (fall through to next mutator / continueResponse unmodified)
 *   - `string` to replace the body with that content
 *
 * Mutators receive the (already-decoded) UTF-8 body. Multiple mutators
 * can register against the same pattern; they chain in registration order.
 *
 * Bytes ARE written back via `Fetch.fulfillRequest`, so any integrity
 * check the upstream script does on itself (CSP `sha256-…` pin, ECDSA
 * `MEUC` header, runtime self-checksum) WILL detect the change. Use
 * mutators only on bundles that don't self-check (e.g. Next.js builds).
 */
export type ScriptMutator = (s: CapturedScript) => string | null | Promise<string | null>;

interface InstalledScript {
	id: string;
	source: string;
	/** CDP scriptIdentifier returned by Page.addScriptToEvaluateOnNewDocument. */
	identifier: string;
}

interface ChildSessionState {
	session: CDPSession;
	installed: Map<string, InstalledScript>;
	page: Page;
}

// ─── CDP wire types (subset) ──────────────────────────────────────────────

interface FetchRequestPausedEvent {
	requestId: string;
	request: {
		url: string;
		method: string;
		headers: Record<string, string>;
	};
	frameId: string;
	resourceType: string;
	responseStatusCode?: number;
	responseHeaders?: Array<{ name: string; value: string }>;
	networkId?: string;
	redirectedRequestId?: string;
}

interface FetchGetResponseBodyResult {
	body: string;
	base64Encoded: boolean;
}

interface AddScriptResult {
	identifier: string;
}

interface RuntimeBindingCalledEvent {
	name: string;
	payload: string;
	executionContextId: number;
}

interface InstalledBinding {
	name: string;
	handler: BindingHandler;
}

/**
 * Page-side `window[name](payload)` -> Node. The page calls a globally-
 * exposed function with a single string argument and gets back `undefined`
 * synchronously. The Node-side handler receives the payload (and the CDP
 * execution context id, useful for distinguishing parent vs iframe calls).
 *
 * Bindings are a one-way channel by design (CDP gives no return-value
 * route). For request/response, dispatch a custom event back into the page
 * via `Runtime.evaluate` keyed on a request id you embed in the payload.
 */
export type BindingHandler = (payload: string, executionContextId: number) => void | Promise<void>;

// ─── Implementation ───────────────────────────────────────────────────────

/**
 * Centralised raw-CDP control for init scripts and (optional) script-body
 * capture. Owns one root session per page; auto-attaches to child page targets.
 */
export class CdpScriptControl extends EventEmitter {
	private context: BrowserContext | null = null;
	private rootPage: Page | null = null;
	private rootSession: CDPSession | null = null;
	private rootInstalled: Map<string, InstalledScript> = new Map();
	private childSessions: Map<string, ChildSessionState> = new Map();
	private scripts: Map<string, string> = new Map(); // handle.id → source
	private fetchHandlers: Map<string, CaptureHandler> = new Map(); // handle.id → handler
	private fetchPatterns: Map<string, FetchCaptureOptions> = new Map();
	private mutateHandlers: Map<string, ScriptMutator> = new Map(); // handle.id → mutator
	private mutatePatterns: Map<string, FetchCaptureOptions> = new Map();
	private bindings: Map<string, InstalledBinding> = new Map(); // name -> handler
	private fetchListenerInstalled = false;
	private attached = false;
	private contextPageHandler: ((p: Page) => void) | null = null;

	// ─── Lifecycle ─────────────────────────────────────────────────────

	/**
	 * Start raw-CDP control on a context + its primary page.
	 *
	 * Call BEFORE the page navigates anywhere meaningful. Init scripts
	 * registered after a navigation only apply to subsequent navigations.
	 */
	async attach(context: BrowserContext, page: Page): Promise<void> {
		if (this.attached) return;
		this.context = context;
		this.rootPage = page;
		this.rootSession = await context.newCDPSession(page);
		this.attached = true;

		// Enable the Page domain so Fetch capture downstream sees frame events.
		// We do NOT call Target.setAutoAttach: Patchright manages auto-attach
		// on its own connection, and a duplicate call from our session can
		// scramble the session that Chromium uses to apply init scripts.
		await this.rootSession.send('Page.enable').catch(() => {});

		// New page targets (popups, opener-spawned tabs) need their own session.
		this.contextPageHandler = (newPage: Page) => {
			void this.adoptChildPage(newPage).catch((err) => {
				this.emit('error', new Error(`adoptChildPage failed: ${String(err)}`));
			});
		};
		context.on('page', this.contextPageHandler);

		// Adopt any pre-existing pages other than the root.
		for (const p of context.pages()) {
			if (p === page) continue;
			await this.adoptChildPage(p).catch(() => {});
		}
	}

	async detach(): Promise<void> {
		if (!this.attached) return;
		this.attached = false;

		if (this.context && this.contextPageHandler) {
			this.context.off('page', this.contextPageHandler);
			this.contextPageHandler = null;
		}

		// Best-effort teardown of child sessions.
		for (const state of this.childSessions.values()) {
			try {
				await state.session.detach();
			} catch {
				/* page already closed */
			}
		}
		this.childSessions.clear();

		if (this.rootSession) {
			try {
				if (this.fetchListenerInstalled) {
					await this.rootSession.send('Fetch.disable').catch(() => {});
				}
				await this.rootSession
					.send('Target.setAutoAttach', {
						autoAttach: false,
						waitForDebuggerOnStart: false,
						flatten: true,
					})
					.catch(() => {});
				await this.rootSession.detach();
			} catch {
				/* root page closed */
			}
		}

		this.rootSession = null;
		this.rootPage = null;
		this.context = null;
		this.rootInstalled.clear();
		this.scripts.clear();
		this.fetchHandlers.clear();
		this.fetchPatterns.clear();
		this.fetchListenerInstalled = false;
		this.bindings.clear();
	}

	/**
	 * Adopt a non-root page into the control surface. Idempotent.
	 *
	 * Called automatically when the context emits 'page' (popups, opener-
	 * spawned tabs). Service code that creates pages explicitly via
	 * `context.newPage()` should call this manually right after creation to
	 * avoid the brief window where the new page exists but `context.on('page')`
	 * hasn't fired yet.
	 */
	async adoptChildPage(page: Page): Promise<void> {
		if (!this.context || !this.attached) return;
		if (page === this.rootPage) return;

		// Idempotency: skip if already adopted.
		for (const state of this.childSessions.values()) {
			if (state.page === page) return;
		}

		const session = await this.context.newCDPSession(page);
		await session.send('Page.enable').catch(() => {});

		const state: ChildSessionState = { session, installed: new Map(), page };
		const sid = randomUUID();
		this.childSessions.set(sid, state);

		// Install all currently-registered scripts on the child.
		for (const [id, source] of this.scripts) {
			const result = (await session
				.send('Page.addScriptToEvaluateOnNewDocument', {
					source,
					runImmediately: true,
				})
				.catch(() => null)) as AddScriptResult | null;
			if (result) {
				state.installed.set(id, { id, source, identifier: result.identifier });
			}
		}

		// Install Fetch capture too (per-session — Fetch.enable must be sent
		// to each session that should pause requests).
		await this.applyFetchToSession(session).catch(() => {});

		// Re-install all currently-registered bindings on the child.
		if (this.bindings.size > 0) {
			this.installBindingListener(session);
			for (const name of this.bindings.keys()) {
				await session.send('Runtime.addBinding', { name }).catch(() => {});
			}
		}

		// Clean up when page closes.
		page.once('close', () => {
			this.childSessions.delete(sid);
		});
	}

	// ─── Init scripts ─────────────────────────────────────────────────

	/**
	 * Install a JS source string as an init script on every current and future
	 * page session. Runs in the main world before any in-page script and is
	 * auto-propagated by Chromium to cross-origin subframes.
	 */
	async registerInitScript(source: string): Promise<InitScriptHandle> {
		if (!this.attached || !this.rootSession) {
			throw new Error('CdpScriptControl.registerInitScript called before attach()');
		}

		const id = randomUUID();
		this.scripts.set(id, source);

		// Install on root via context-level addInitScript so the script applies
		// to every page in the context AND to subframes/OOPIFs (Patchright
		// propagates by issuing Page.addScriptToEvaluateOnNewDocument on the
		// session that actually drives each page's renderer — calling the same
		// CDP method on a separate CDPSession we create ourselves does NOT
		// apply, because Chromium scopes init-script lists per-session).
		if (this.context) {
			await this.context.addInitScript(source);
		}
		// Also register on the existing root page directly: context.addInitScript
		// only applies to pages created AFTER the call, and persistent contexts
		// hand us a pre-existing about:blank page.
		if (this.rootPage) {
			await this.rootPage.addInitScript(source);
		}
		// Mirror to our raw-CDP session so the identifier is tracked for
		// unregister(). The raw-CDP call may be a no-op for the rendering
		// target but the identifier lets us call removeScriptToEvaluateOnNewDocument
		// later if we ever do find a session-routing path.
		try {
			const rootResult = (await this.rootSession.send('Page.addScriptToEvaluateOnNewDocument', {
				source,
				runImmediately: true,
			})) as AddScriptResult;
			this.rootInstalled.set(id, { id, source, identifier: rootResult.identifier });
		} catch {
			/* not fatal — Patchright's addInitScript is the load-bearing path */
		}

		// Install on every existing child session via Patchright as well.
		for (const state of this.childSessions.values()) {
			await state.page.addInitScript(source).catch(() => {});
			const result = (await state.session
				.send('Page.addScriptToEvaluateOnNewDocument', {
					source,
					runImmediately: true,
				})
				.catch(() => null)) as AddScriptResult | null;
			if (result) {
				state.installed.set(id, { id, source, identifier: result.identifier });
			}
		}

		return { id };
	}

	async unregisterInitScript(handle: InitScriptHandle): Promise<void> {
		const removed = this.scripts.delete(handle.id);
		if (!removed) return;

		const rootInfo = this.rootInstalled.get(handle.id);
		if (this.rootSession && rootInfo) {
			await this.rootSession
				.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: rootInfo.identifier })
				.catch(() => {});
			this.rootInstalled.delete(handle.id);
		}

		for (const state of this.childSessions.values()) {
			const info = state.installed.get(handle.id);
			if (!info) continue;
			await state.session
				.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: info.identifier })
				.catch(() => {});
			state.installed.delete(handle.id);
		}
	}

	// ─── Script body capture (analysis only) ──────────────────────────

	/**
	 * Capture matching response bodies as they fly past. Does NOT modify
	 * bytes. Useful for log/analysis mode (e.g., dump the live Turnstile
	 * bundle to disk for offline reverse-engineering).
	 *
	 * Returns a stop() function that disables this capture.
	 */
	async captureScripts(
		opts: FetchCaptureOptions,
		handler: CaptureHandler,
	): Promise<() => Promise<void>> {
		if (!this.attached || !this.rootSession) {
			throw new Error('CdpScriptControl.captureScripts called before attach()');
		}

		const id = randomUUID();
		this.fetchHandlers.set(id, handler);
		this.fetchPatterns.set(id, opts);

		await this.applyFetchToSession(this.rootSession);
		for (const state of this.childSessions.values()) {
			await this.applyFetchToSession(state.session).catch(() => {});
		}

		return async () => {
			this.fetchHandlers.delete(id);
			this.fetchPatterns.delete(id);
			// If no patterns remain, disable Fetch on every session.
			if (this.fetchPatterns.size === 0) {
				if (this.rootSession) {
					await this.rootSession.send('Fetch.disable').catch(() => {});
				}
				for (const state of this.childSessions.values()) {
					await state.session.send('Fetch.disable').catch(() => {});
				}
				this.fetchListenerInstalled = false;
			} else if (this.rootSession) {
				await this.applyFetchToSession(this.rootSession);
				for (const state of this.childSessions.values()) {
					await this.applyFetchToSession(state.session).catch(() => {});
				}
			}
		};
	}

	/**
	 * Mutate matching response bodies. Return `null` from the mutator to
	 * pass through unmodified; return a string to replace the body. Bytes
	 * are written back via `Fetch.fulfillRequest`. See `ScriptMutator`.
	 *
	 * Returns a stop() function that disables this mutator.
	 */
	async decorateScript(
		opts: FetchCaptureOptions,
		mutator: ScriptMutator,
	): Promise<() => Promise<void>> {
		if (!this.attached || !this.rootSession) {
			throw new Error('CdpScriptControl.decorateScript called before attach()');
		}
		const id = randomUUID();
		this.mutateHandlers.set(id, mutator);
		this.mutatePatterns.set(id, opts);

		await this.applyFetchToSession(this.rootSession);
		for (const state of this.childSessions.values()) {
			await this.applyFetchToSession(state.session).catch(() => {});
		}

		return async () => {
			this.mutateHandlers.delete(id);
			this.mutatePatterns.delete(id);
			if (this.fetchPatterns.size === 0 && this.mutatePatterns.size === 0 && this.rootSession) {
				await this.rootSession.send('Fetch.disable').catch(() => {});
				for (const state of this.childSessions.values()) {
					await state.session.send('Fetch.disable').catch(() => {});
				}
				this.fetchListenerInstalled = false;
			} else if (this.rootSession) {
				await this.applyFetchToSession(this.rootSession);
				for (const state of this.childSessions.values()) {
					await this.applyFetchToSession(state.session).catch(() => {});
				}
			}
		};
	}

	private async applyFetchToSession(session: CDPSession): Promise<void> {
		if (this.fetchPatterns.size === 0 && this.mutatePatterns.size === 0) return;

		// Mutators rewrite bytes via Fetch.fulfillRequest. If Chromium serves
		// the response from disk/memory cache, Fetch.requestPaused never fires
		// for that request, so the mutator silently no-ops. Disable cache when
		// any mutator is registered. Read-only captures work either way.
		if (this.mutatePatterns.size > 0) {
			await session.send('Network.enable').catch(() => {});
			await session.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
		}

		const allPatterns = [...this.fetchPatterns.values(), ...this.mutatePatterns.values()];
		const patterns = allPatterns.map((opts) => ({
			urlPattern: opts.urlPattern,
			resourceType: opts.resourceType ?? 'Script',
			requestStage: 'Response' as const,
		}));

		await session.send('Fetch.enable', { patterns });

		if (!this.fetchListenerInstalled) {
			this.fetchListenerInstalled = true;
		}

		// Listener is idempotent — register once per session.
		const sessionAny = session as unknown as {
			__cdpScriptControlBound?: boolean;
		};
		if (sessionAny.__cdpScriptControlBound) return;
		sessionAny.__cdpScriptControlBound = true;

		session.on('Fetch.requestPaused', (raw: unknown) => {
			void this.onRequestPaused(session, raw as FetchRequestPausedEvent).catch(() => {});
		});
	}

	private async onRequestPaused(
		session: CDPSession,
		event: FetchRequestPausedEvent,
	): Promise<void> {
		// Only handle Response stage (responseStatusCode set).
		const isResponseStage = typeof event.responseStatusCode === 'number';

		if (!isResponseStage) {
			// Pass through at request stage — we configured Response stage
			// only, so we shouldn't normally see this, but handle defensively.
			await session.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
			return;
		}

		// Find capture (read-only) and mutate handlers whose pattern matches.
		const captureMatches: CaptureHandler[] = [];
		for (const [id, opts] of this.fetchPatterns) {
			if (matchesGlob(event.request.url, opts.urlPattern)) {
				const h = this.fetchHandlers.get(id);
				if (h) captureMatches.push(h);
			}
		}
		const mutateMatches: ScriptMutator[] = [];
		for (const [id, opts] of this.mutatePatterns) {
			if (matchesGlob(event.request.url, opts.urlPattern)) {
				const m = this.mutateHandlers.get(id);
				if (m) mutateMatches.push(m);
			}
		}

		const needBody = captureMatches.length > 0 || mutateMatches.length > 0;
		let captured: CapturedScript | null = null;

		if (needBody) {
			try {
				const body = (await session.send('Fetch.getResponseBody', {
					requestId: event.requestId,
				})) as FetchGetResponseBodyResult;

				const headers: Record<string, string> = {};
				for (const h of event.responseHeaders ?? []) {
					headers[h.name.toLowerCase()] = h.value;
				}

				captured = {
					url: event.request.url,
					method: event.request.method,
					frameId: event.frameId,
					resourceType: event.resourceType,
					responseStatusCode: event.responseStatusCode ?? 0,
					responseHeaders: headers,
					body: body.body,
					base64Encoded: body.base64Encoded,
				};

				for (const h of captureMatches) {
					try {
						await h(captured);
					} catch {
						/* user handler errors are isolated */
					}
				}
			} catch {
				/* getResponseBody can fail if the request was already cancelled */
			}
		}

		// If any mutator returned a non-null body, fulfill with the new bytes.
		if (captured && mutateMatches.length > 0) {
			let mutated: string | null = null;
			let workingBody = captured.base64Encoded
				? Buffer.from(captured.body, 'base64').toString('utf8')
				: captured.body;
			for (const m of mutateMatches) {
				try {
					const next = await m({ ...captured, body: workingBody, base64Encoded: false });
					if (typeof next === 'string') {
						mutated = next;
						workingBody = next;
					}
				} catch {
					/* mutator errors are isolated */
				}
			}
			if (mutated !== null) {
				const responseHeaders = (event.responseHeaders ?? [])
					.filter((h) => h.name.toLowerCase() !== 'content-length')
					.map((h) => ({ name: h.name, value: h.value }));
				responseHeaders.push({
					name: 'content-length',
					value: String(Buffer.byteLength(mutated, 'utf8')),
				});
				await session
					.send('Fetch.fulfillRequest', {
						requestId: event.requestId,
						responseCode: event.responseStatusCode ?? 200,
						responseHeaders,
						body: Buffer.from(mutated, 'utf8').toString('base64'),
					})
					.catch(() => {});
				return;
			}
		}

		// Default path: continue the response unmodified.
		await session.send('Fetch.continueResponse', { requestId: event.requestId }).catch(() => {});
	}

	// ─── Main-world evaluator ─────────────────────────────────────────

	/**
	 * Evaluate an expression in the page's MAIN world (not the isolated
	 * world Patchright's `page.evaluate` uses). Returns the unwrapped
	 * value or null on failure.
	 *
	 * Use this when you need to read state set by an init script — for
	 * example, a property logger that writes to `top.__deep_log` is
	 * invisible to `page.evaluate` because that runs in an isolated
	 * world with its own copy of the window globals.
	 *
	 * @param expression  the JS expression to evaluate
	 * @param opts.awaitPromise  if the expression evaluates to a Promise,
	 *   await it before returning (CDP `awaitPromise`). Default: false.
	 * @param opts.timeoutMs  hard timeout when awaiting a promise.
	 *   Defaults to 30s.
	 */
	async evaluateInMainWorld<T = unknown>(
		expression: string,
		opts: { awaitPromise?: boolean; timeoutMs?: number; page?: Page } = {},
	): Promise<T | null> {
		// Default: evaluate on the root session. If `page` is provided, find
		// the matching child session so callers can target a specific
		// adopted page's main world.
		let session: CDPSession | null = this.rootSession;
		if (opts.page && opts.page !== this.rootPage) {
			session = null;
			for (const state of this.childSessions.values()) {
				if (state.page === opts.page) {
					session = state.session;
					break;
				}
			}
		}
		if (!session) return null;
		try {
			const result = (await session.send('Runtime.evaluate', {
				expression,
				returnByValue: true,
				awaitPromise: opts.awaitPromise ?? false,
				timeout: opts.timeoutMs ?? 30000,
			})) as { result?: { value?: T }; exceptionDetails?: unknown };
			if (result.exceptionDetails) return null;
			return (result.result?.value ?? null) as T | null;
		} catch {
			return null;
		}
	}

	// ─── Page → Node bindings (Runtime.addBinding) ────────────────────

	/**
	 * Expose `window[name]` on every current and future page session. The
	 * page calls `window[name](stringPayload)` and the Node-side handler is
	 * invoked with the payload + the CDP execution context id (useful for
	 * disambiguating parent vs OOPIF callers).
	 *
	 * Notes:
	 *  - `Runtime.addBinding` only takes effect for execution contexts
	 *    created AFTER the call. For existing pages we install bindings on
	 *    every session we own; new pages adopted later get them in
	 *    `adoptChildPage`.
	 *  - Binding propagation to OOPIFs requires the child target to be
	 *    attached. Patchright auto-attaches same-origin iframes; cross-
	 *    origin iframes (like the hCaptcha SDK at newassets.hcaptcha.com)
	 *    live in a separate target that we typically do NOT see on these
	 *    sessions. Reach the cross-origin iframe via parent-page postMessage
	 *    rather than expecting the binding to land directly inside it.
	 *  - There is NO return-value channel — the page-side function returns
	 *    `undefined`. Build request/response on top by dispatching a custom
	 *    event back into the page from Node via `evaluateInMainWorld`.
	 */
	async addBinding(name: string, handler: BindingHandler): Promise<void> {
		if (!this.attached || !this.rootSession) {
			throw new Error('CdpScriptControl.addBinding called before attach()');
		}
		if (this.bindings.has(name)) {
			throw new Error(`Binding "${name}" already registered`);
		}
		this.bindings.set(name, { name, handler });

		this.installBindingListener(this.rootSession);
		await this.rootSession.send('Runtime.addBinding', { name }).catch(() => {});

		for (const state of this.childSessions.values()) {
			this.installBindingListener(state.session);
			await state.session.send('Runtime.addBinding', { name }).catch(() => {});
		}
	}

	async removeBinding(name: string): Promise<void> {
		if (!this.bindings.delete(name)) return;
		if (this.rootSession) {
			await this.rootSession.send('Runtime.removeBinding', { name }).catch(() => {});
		}
		for (const state of this.childSessions.values()) {
			await state.session.send('Runtime.removeBinding', { name }).catch(() => {});
		}
	}

	private installBindingListener(session: CDPSession): void {
		const sessionAny = session as unknown as { __cdpBindingBound?: boolean };
		if (sessionAny.__cdpBindingBound) return;
		sessionAny.__cdpBindingBound = true;
		session.on('Runtime.bindingCalled', (raw: unknown) => {
			const ev = raw as RuntimeBindingCalledEvent;
			const b = this.bindings.get(ev.name);
			if (!b) return;
			void Promise.resolve()
				.then(() => b.handler(ev.payload, ev.executionContextId))
				.catch((err) => {
					this.emit('error', new Error(`binding ${ev.name} handler threw: ${String(err)}`));
				});
		});
	}

	// ─── Diagnostics ───────────────────────────────────────────────────

	getStatus(): {
		attached: boolean;
		scriptsRegistered: number;
		childSessions: number;
		fetchPatterns: number;
	} {
		return {
			attached: this.attached,
			scriptsRegistered: this.scripts.size,
			childSessions: this.childSessions.size,
			fetchPatterns: this.fetchPatterns.size,
		};
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal glob matcher matching CDP's url pattern semantics: `*` matches any
 * characters. Used to dispatch a single Fetch.requestPaused stream to per-
 * pattern handlers.
 */
function matchesGlob(url: string, pattern: string): boolean {
	if (pattern === '*' || pattern === '') return true;
	const regex = new RegExp(
		`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`,
	);
	return regex.test(url);
}
