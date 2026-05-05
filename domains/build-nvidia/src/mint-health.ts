/**
 * Mint health tracking + resilience helpers for build-nvidia.
 *
 * The captcha mint flow has three failure modes that operators care about:
 *  1. Transient — happens once, next call works (NVIDIA flicker, single
 *     captcha challenge that resolved itself). Don't surface.
 *  2. Persistent — same error N times in a row. Browser session is stuck;
 *     operator should reconnect. Surface with actionable guidance.
 *  3. IP block — every model returns the same captcha error. The IP got
 *     temp-banned. Operator should switch network / VPN.
 *
 * This module tracks mint outcomes and produces operator-friendly error
 * messages instead of raw stack traces.
 *
 * @module domain-build-nvidia/mint-health
 */

import { DEBUG } from '@interceptor/shared';

interface MintRecord {
	totalCalls: number;
	consecutiveFailures: number;
	lastSuccessAt: number; // unix ms; 0 = never
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

/** Record a successful captcha mint. Resets the consecutive-failure counter. */
export function recordMintSuccess(): void {
	state.totalCalls += 1;
	state.consecutiveFailures = 0;
	state.lastSuccessAt = Date.now();
}

/** Record a failed captcha mint. Tracks the consecutive count for surfacing. */
export function recordMintFailure(message: string): void {
	state.totalCalls += 1;
	state.consecutiveFailures += 1;
	state.lastFailureAt = Date.now();
	state.lastFailureMessage = message;
	DEBUG('build-nvidia', `mint failure #${state.consecutiveFailures}: ${message}`);
}

/** Read the current mint health snapshot — exposed via /v1/health. */
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

/**
 * Convert a raw mint error message into operator-friendly guidance. The
 * raw error often says "SDK trap or widget not ready before timeout" with
 * no hint about what to do. This decorates with a concrete next step.
 *
 * If the failure has been persistent (≥ 3 consecutive), upgrades the
 * suggestion: probably the IP has been blocked or the browser process
 * has crashed, not just a single stuck page.
 */
export function decorateMintError(rawMessage: string): {
	message: string;
	suggestion: string;
	severity: 'transient' | 'persistent' | 'likely_ip_block';
} {
	const lower = rawMessage.toLowerCase();
	const severity: 'transient' | 'persistent' | 'likely_ip_block' =
		state.consecutiveFailures >= PERSISTENT_FAILURE_THRESHOLD
			? state.consecutiveFailures >= 8
				? 'likely_ip_block'
				: 'persistent'
			: 'transient';

	let suggestion: string;
	if (severity === 'likely_ip_block') {
		suggestion =
			'Persistent mint failures across many requests — likely an IP block from NVIDIA. Switch network / disconnect VPN to get a fresh egress IP, then reconnect the browser.';
	} else if (severity === 'persistent') {
		suggestion =
			"Browser session appears stuck (3+ consecutive mint failures). Reconnect: `pkill -f connect-browser; ./scripts/connect-browser.sh --profile build-nvidia --url 'https://build.nvidia.com/openai/gpt-oss-20b' --port 3001`. Wait ~25s before retrying.";
	} else if (lower.includes('sdk trap') || lower.includes('widget not ready')) {
		suggestion =
			'Page may not have finished loading the hCaptcha widget. Retry once; if it persists, reconnect the browser session.';
	} else if (lower.includes('captcha required') || lower.includes('token is invalid')) {
		suggestion =
			'Captcha token expired between mint and use. Retry — the route auto-remints once on this error.';
	} else {
		suggestion = 'Transient upstream failure. Retry.';
	}

	return { message: rawMessage, suggestion, severity };
}

/**
 * Standard upstream-fetch timeout for predict/embed/audio/asset routes.
 * 60s is generous for image-gen but prevents hung connections from
 * pinning the server indefinitely on a runaway request.
 */
export const UPSTREAM_TIMEOUT_MS = 60_000;

/**
 * Wrap a fetch with an AbortSignal-based timeout. Use on every upstream
 * call to api.ngc.nvidia.com / s3-accelerate.amazonaws.com so a stalled
 * upstream can't hold the response queue forever.
 */
export function fetchWithTimeout(
	url: string | URL,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
	const { timeoutMs = UPSTREAM_TIMEOUT_MS, ...rest } = init;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`Upstream timeout after ${timeoutMs}ms`)), timeoutMs);
	return fetch(url, { ...rest, signal: rest.signal ?? controller.signal })
		.finally(() => clearTimeout(timer));
}
