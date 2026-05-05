/**
 * Sentinel mint health tracking + resilience helpers for chatgpt.
 *
 * Same shape as build-nvidia's mint-health module — tracks consecutive
 * Sentinel-token failures and surfaces operator-friendly guidance instead
 * of cryptic stack traces. Key failure modes:
 *
 *  1. Transient — Sentinel SDK returns malformed JSON for one call. Retry.
 *  2. Persistent — same error N times. Browser session is stuck or the
 *     Sentinel iframe isn't loading. Operator should reconnect the browser.
 *  3. Account/IP block — every conversation POST returns 401/403/429.
 *     Switch network or re-login.
 *
 * @module domain-chatgpt/mint-health
 */

import { DEBUG } from '@interceptor/shared';

interface MintRecord {
	totalCalls: number;
	consecutiveFailures: number;
	lastSuccessAt: number;
	lastFailureAt: number;
	lastFailureMessage: string;
}

const PERSISTENT_FAILURE_THRESHOLD = 3;

const state: MintRecord = {
	totalCalls: 0,
	consecutiveFailures: 0,
	lastSuccessAt: 0,
	lastFailureAt: 0,
	lastFailureMessage: '',
};

export function recordMintSuccess(): void {
	state.totalCalls += 1;
	state.consecutiveFailures = 0;
	state.lastSuccessAt = Date.now();
}

export function recordMintFailure(message: string): void {
	state.totalCalls += 1;
	state.consecutiveFailures += 1;
	state.lastFailureAt = Date.now();
	state.lastFailureMessage = message;
	DEBUG('chatgpt', `sentinel mint failure #${state.consecutiveFailures}: ${message}`);
}

export function getMintHealth(): {
	total_calls: number;
	consecutive_failures: number;
	last_success_at: number | null;
	last_failure_at: number | null;
	last_failure_message: string | null;
	stuck: boolean;
} {
	return {
		total_calls: state.totalCalls,
		consecutive_failures: state.consecutiveFailures,
		last_success_at: state.lastSuccessAt || null,
		last_failure_at: state.lastFailureAt || null,
		last_failure_message: state.lastFailureMessage || null,
		stuck: state.consecutiveFailures >= PERSISTENT_FAILURE_THRESHOLD,
	};
}

/** Decorate a Sentinel mint error with operator-friendly guidance. */
export function decorateMintError(rawMessage: string): {
	message: string;
	suggestion: string;
	severity: 'transient' | 'persistent' | 'likely_blocked';
} {
	const lower = rawMessage.toLowerCase();
	const severity: 'transient' | 'persistent' | 'likely_blocked' =
		state.consecutiveFailures >= PERSISTENT_FAILURE_THRESHOLD
			? state.consecutiveFailures >= 8
				? 'likely_blocked'
				: 'persistent'
			: 'transient';

	let suggestion: string;
	if (severity === 'likely_blocked') {
		suggestion =
			'Persistent Sentinel mint failures across many requests — likely an account or IP block from OpenAI. Switch network / disconnect VPN, or open chatgpt.com manually to clear any captcha challenge, then reconnect the browser.';
	} else if (severity === 'persistent') {
		suggestion =
			'Browser session appears stuck (3+ consecutive Sentinel failures). Reconnect: `pkill -f connect-browser; ./scripts/connect-browser.sh --profile chatgpt --url https://chatgpt.com`. Wait ~25s; then re-harvest: `curl -X POST http://localhost:3001/api/chatgpt/session/harvest`.';
	} else if (lower.includes('sentinelsdk not available') || lower.includes('not on chatgpt.com')) {
		suggestion =
			'Browser page is not on chatgpt.com or the Sentinel SDK has not loaded yet. Navigate to https://chatgpt.com in the connected browser and wait for it to fully render.';
	} else if (lower.includes('non-json') || lower.includes('missing fields')) {
		suggestion =
			'Sentinel SDK returned an unexpected payload — Cloudflare or OpenAI may be rolling out a change. Retry once; if it persists, capture the response with /experiments/install-deep-logger and inspect.';
	} else if (lower.includes('401') || lower.includes('access') || lower.includes('forbidden')) {
		suggestion =
			'Auth failure — the harvested Bearer token may be expired. Re-harvest: `curl -X POST http://localhost:3001/api/chatgpt/session/harvest`.';
	} else {
		suggestion = 'Transient upstream failure. Retry.';
	}

	return { message: rawMessage, suggestion, severity };
}

/**
 * Standard upstream-fetch timeout for /backend-anon/f/conversation.
 * 90s is generous for long replies (gpt-5 with reasoning tokens) without
 * pinning a connection forever on a stuck request.
 */
export const UPSTREAM_TIMEOUT_MS = 90_000;

export function fetchWithTimeout(
	url: string | URL,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
	const { timeoutMs = UPSTREAM_TIMEOUT_MS, ...rest } = init;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`Upstream timeout after ${timeoutMs}ms`)),
		timeoutMs,
	);
	return fetch(url, { ...rest, signal: rest.signal ?? controller.signal }).finally(() =>
		clearTimeout(timer),
	);
}
