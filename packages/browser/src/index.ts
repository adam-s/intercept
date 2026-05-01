/**
 * @interceptor/browser — Stealth browser automation package
 *
 * Core primitives for Patchright-based browser automation:
 * - Stealth browser launcher with proxy support
 * - User-Agent pools and anti-detection configuration
 * - Browser pool with lazy init, tab reuse, and idle timeout
 * - Ghostery-based ad/tracker blocker with disk cache
 * - Scraper registry for managing multiple data sources
 *
 * @module browser
 */

// Blocker
export { BlockerManager, getBlockerManager } from './blocker';
// Config
export { type BrowserConfig, getBrowserConfig } from './config';
// Browser pool
export { BrowserPool, getBrowserPool } from './pool';
// Scraper Registry
export {
	createHealthCheck,
	defineScraper,
	getScraperRegistry,
	type RegisteredScraper,
	type ScraperFetchFn,
	type ScraperHealthCheckFn,
	type ScraperHealthResult,
	type ScraperMeta,
	type ScraperRateLimit,
	ScraperRegistry,
	type ScraperSchedule,
} from './registry';
// Stealth configuration (UA pools, args, headers)
export {
	buildFetchHeaders,
	buildHtmlHeaders,
	buildXhrHeaders,
	COMMON_VIEWPORTS,
	DESKTOP_USER_AGENTS,
	getMostCommonDesktopUA,
	getRandomDesktopUA,
	getRandomMobileUA,
	MOBILE_USER_AGENTS,
	STEALTH_BROWSER_ARGS,
} from './stealth';
// Stealth browser
export { type BrowserOptions, createBrowser, createBrowserContext } from './stealth-browser';

// Types
export {
	type BrowserLaunchOptions,
	type BrowserSession,
	type CalendarEvent,
	type DataSource,
	err,
	type ImpactLevel,
	ok,
	type Result,
	type ScraperError,
	type ScraperErrorType,
	type ScraperOptions,
	scraperError,
} from './types';
