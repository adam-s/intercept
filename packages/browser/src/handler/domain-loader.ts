/**
 * Domain Plugin Loader
 *
 * Provides a runtime registry for domain plugins. Domain packages
 * (e.g., @interceptor/domain-boardshop) export a DomainPlugin object
 * and register it at application startup.
 *
 * The browser handler uses getDomain() to look up plugins by name.
 * The framework has zero knowledge of specific domains — all domain
 * logic lives in separate packages.
 *
 * Usage:
 *   // In your app's startup (e.g., apps/api/src/register-domains.ts):
 *   import { registerDomain } from '@interceptor/browser/handler';
 *   import { plugin } from '@interceptor/domain-boardshop';
 *   registerDomain(plugin);
 *
 *   // In the browser handler (automatic):
 *   const plugin = getDomain('boardshop');
 *   if (plugin) { ... attach interceptor, verify credentials, etc. }
 *
 * @module browser/handler/domain-loader
 */

import type { Context } from 'hono';
import type { RemoteBrowserService } from '../remote/service.js';
import type { InterceptorConfig, VerificationResult } from '../shared/config.js';
import type { GenericInterceptor } from '../shared/interceptor.js';

/**
 * A transport class, named exactly as the elimination table names it.
 *
 * Deliberately a bare string rather than a union of the seventeen current row
 * names. The canonical list lives with the scanner that detects them, in plain
 * JavaScript that this TypeScript cannot import at build time, and duplicating
 * it here would create the two-lists drift this project keeps paying for. A
 * repo-level test reconciles what routes declare against that canonical list,
 * so a typo fails CI rather than the compiler — a worse error message, but one
 * list instead of two.
 */
export type TransportName = string;

/**
 * A single API route that can be proxied through the browser.
 *
 * Two dispatch modes:
 * - `targetUrl`: simple proxy — calls `browserFetch(targetUrl)` with cookies inherited automatically (Type A)
 * - `handler`: custom logic — full access to Hono context + browser for SSR extraction, traffic capture, etc. (Type B/B2/C)
 *
 * Exactly one of `targetUrl` or `handler` must be provided.
 */
export type DomainRoute =
	| {
			method: 'GET' | 'POST' | 'PUT' | 'DELETE';
			path: string;
			targetUrl: string;
			handler?: never;
			description?: string;
			/** When false, proxy skips the browser-connected check. Use for routes that do direct fetch() without Patchright. Default: true */
			browserRequired?: boolean;
			/** Concrete invocations that exercise this route. See `examples` on the handler variant. */
			examples?: string[];
			/**
			 * Non-2xx statuses that are contractual answers for this route.
			 *
			 * Narrow on purpose, and not the same as widening what counts as
			 * success. Some resources are genuinely not always present — a live
			 * broadcast when nobody is on air — and for those, "there is none right
			 * now" is a complete answer rather than a fault. Without this such a
			 * route is permanently red, which teaches a reader to skip the domain.
			 *
			 * The obligation travels with the declaration: the transport must be
			 * proved somewhere that IS deterministic, and the comment at the route
			 * must say where. A declaration without that sibling is a check that
			 * cannot fail.
			 */
			contractualStatuses?: number[];
			/** Upstream endpoints this route consumes. See `upstream` on the handler variant. */
			upstream?: string[];
			/** Transport class this route consumes. See `transport` on the handler variant. */
			transport?: TransportName;
	  }
	| {
			method: 'GET' | 'POST' | 'PUT' | 'DELETE';
			path: string;
			targetUrl?: never;
			handler: (c: Context, browser: RemoteBrowserService) => Promise<Response>;
			description?: string;
			/** When false, proxy skips the browser-connected check. Use for routes that do direct fetch() without Patchright. Default: true */
			browserRequired?: boolean;
			/**
			 * Concrete invocations that exercise this route, relative to the domain
			 * mount — e.g. `['/search?q=tesla', '/chart/MSFT?range=5d']`.
			 *
			 * A route with a path parameter or a required query parameter cannot be
			 * probed from its declaration alone: `/search` without `?q=` is a 400 by
			 * design, and `/chart/:symbol` is not a URL. Without an example such a
			 * route is simply skipped, so the checker reports green over a route
			 * nothing ever called. Declaring one example makes the route testable;
			 * declaring several covers its interesting cases.
			 */
			examples?: string[];
			/**
			 * Non-2xx statuses that are contractual answers for this route.
			 *
			 * Narrow on purpose, and not the same as widening what counts as
			 * success. Some resources are genuinely not always present — a live
			 * broadcast when nobody is on air — and for those, "there is none right
			 * now" is a complete answer rather than a fault. Without this such a
			 * route is permanently red, which teaches a reader to skip the domain.
			 *
			 * The obligation travels with the declaration: the transport must be
			 * proved somewhere that IS deterministic, and the comment at the route
			 * must say where. A declaration without that sibling is a check that
			 * cannot fail.
			 */
			contractualStatuses?: number[];
			/**
			 * Upstream endpoints this route consumes — e.g.
			 * `['www.reddit.com/r/{sub}.json']` or `['gql.twitch.tv/gql']`.
			 *
			 * A route's own path says nothing about what it calls: `/r/:subreddit`
			 * fetches `/r/all.json`, and `/directory/top` posts to `gql.twitch.tv`.
			 * The coverage check cannot recover that by string similarity — the names
			 * genuinely have nothing in common — so without this it reports endpoints
			 * as unaccounted that are perfectly well covered, and a real gap hides in
			 * the noise. Declaring it makes the recall number mean something.
			 */
			upstream?: string[];
			/**
			 * Transport class this route consumes — one of the elimination table's
			 * row names, e.g. `'GraphQL'` or `'SSE'`.
			 *
			 * The elimination table records which transports a site has; this records
			 * which of them a route actually consumes, so the two can be compared. A
			 * transport marked present with no route naming it is either an
			 * unfinished discovery or a row that was never really there, and without
			 * this field those are indistinguishable from a finished domain.
			 *
			 * It is also what lets the reference domain prove it demonstrates every
			 * row rather than claiming to: a repo test reads these back and fails on
			 * a transport the table asks about and no example shows.
			 */
			transport?: TransportName;
	  };

/**
 * Domain plugin contract.
 *
 * Each domain package exports an object implementing this interface.
 * It provides everything needed to:
 * 1. Intercept traffic (discover APIs)
 * 2. Verify credentials (detect auth state)
 * 3. Proxy API calls through the browser (the service layer)
 */
export interface DomainPlugin {
	/** Unique domain name (e.g., 'boardshop', 'example-finance', 'example-marketplace') */
	domainName: string;

	/** Interceptor configuration (URL patterns, required headers, schema) */
	config: InterceptorConfig;

	/** Factory: create a new interceptor instance for this domain */
	createInterceptor: () => GenericInterceptor;

	/**
	 * API routes to expose via Hono, proxied through browserFetch().
	 * Generated by codegen from captured traffic, or hand-written.
	 * When present, the server mounts these at /api/<domainName>/<path>.
	 */
	routes?: DomainRoute[];

	/** Optional: verify captured credentials against the real API */
	verifyCredentials?: (headers: Record<string, string>) => Promise<VerificationResult>;

	/** Optional: detect if current URL is the login page */
	detectLoginPage?: (url: string) => boolean;

	/** Optional: WebSocket message when verification succeeds */
	onVerified?: (result: VerificationResult) => Record<string, unknown>;

	/** Optional: WebSocket message when verification fails */
	onVerificationFailed?: (error: string) => Record<string, unknown>;

	/** Optional: WebSocket message when login page detected */
	onLoginDetected?: () => Record<string, unknown>;
}

// --- Runtime Registry ---

const plugins = new Map<string, DomainPlugin>();

/**
 * Register a domain plugin.
 *
 * Call this at application startup for each domain you want to support.
 * Typically done in a register-domains.ts file that imports domain packages.
 */
export function registerDomain(plugin: DomainPlugin): void {
	if (plugins.has(plugin.domainName)) {
		console.warn(`[DomainLoader] Overwriting existing plugin: ${plugin.domainName}`);
	}
	plugins.set(plugin.domainName, plugin);
}

/**
 * Get a registered domain plugin by name.
 * Returns undefined if the domain is not registered.
 */
export function getDomain(name: string): DomainPlugin | undefined {
	return plugins.get(name);
}

/**
 * Check if a domain is registered.
 */
export function hasDomain(name: string): boolean {
	return plugins.has(name);
}

/**
 * List all registered domain names.
 */
export function listDomains(): string[] {
	return Array.from(plugins.keys());
}

/**
 * Clear all registered domains (useful for testing).
 */
export function clearDomains(): void {
	plugins.clear();
}
