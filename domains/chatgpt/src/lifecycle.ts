/**
 * Model lifecycle detection for chatgpt.
 *
 * Unlike build-nvidia, chatgpt has no queue endpoint we can probe to
 * pre-flight model availability. Detection is purely reactive: every
 * /v1/chat/completions call records its outcome, and after consecutive
 * failures with deprecation-shaped errors (HTTP 410, "model has been
 * deprecated", etc.) the model is marked deprecated.
 *
 * Plus a static known-bad list seeded from OpenAI's published deprecations.
 *
 * @module domain-chatgpt/lifecycle
 */

import { DEBUG } from '@interceptor/shared';

/**
 * OpenAI's published model deprecations as of 2026-05. Update entries when
 * OpenAI rotates models. Source:
 *   https://platform.openai.com/docs/deprecations
 *
 * The reason is human-readable and surfaces in /v1/models so callers know
 * what to switch to.
 */
export const KNOWN_DEPRECATED: Record<string, string> = {
	'gpt-3.5-turbo-0613':
		'Deprecated by OpenAI. Use gpt-4o-mini for cheap chat or gpt-4o for capable chat.',
	'gpt-3.5-turbo-16k-0613':
		'Deprecated by OpenAI. Use gpt-4o-mini (128k context, cheaper, smarter).',
	'gpt-4-0314': 'Deprecated by OpenAI. Use gpt-4o or gpt-4-turbo.',
	'gpt-4-32k': 'Deprecated by OpenAI. Use gpt-4o (128k context).',
	'text-davinci-003':
		'Deprecated by OpenAI (legacy completions). Use gpt-4o-mini via chat completions.',
};

const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const FAILURE_THRESHOLD = 2;

type FailureKind =
	| 'model_deprecated' // 410 or "model has been deprecated" — definitive
	| 'auth_error' // 401/403 — caller-side, ignored
	| 'rate_limit' // 429 — transient
	| 'sentinel_error' // captcha/sentinel — handled separately by mint-health
	| 'upstream_other'; // 5xx — counted but not dispositive

interface FailureRecord {
	kind: FailureKind;
	count: number;
	lastSeen: number;
	lastError: string;
	lastSuccess: number;
}

const failureCache = new Map<string, FailureRecord>();

/**
 * Record the outcome of a /v1/chat/completions call against a specific
 * model. Used by lifecycle detection to detect models OpenAI has retired.
 */
export function recordChatResult(
	model: string,
	opts: { ok: boolean; status: number; bodyPreview?: string },
): void {
	const now = Date.now();
	if (opts.ok) {
		const r = failureCache.get(model);
		if (r) r.lastSuccess = now;
		else
			failureCache.set(model, {
				kind: 'upstream_other',
				count: 0,
				lastSeen: 0,
				lastError: '',
				lastSuccess: now,
			});
		return;
	}
	const kind = classifyFailure(opts.status, opts.bodyPreview ?? '');
	if (kind === 'auth_error' || kind === 'rate_limit' || kind === 'sentinel_error') return;
	const existing = failureCache.get(model) ?? {
		kind,
		count: 0,
		lastSeen: 0,
		lastError: '',
		lastSuccess: 0,
	};
	if (existing.lastSuccess > existing.lastSeen) existing.count = 0;
	existing.kind = kind;
	existing.count += 1;
	existing.lastSeen = now;
	existing.lastError = (opts.bodyPreview ?? '').slice(0, 300);
	failureCache.set(model, existing);
	DEBUG('chatgpt', `model ${model} failure #${existing.count}: ${kind}`);
}

function classifyFailure(status: number, body: string): FailureKind {
	const lower = body.toLowerCase();
	if (
		status === 410 ||
		lower.includes('has been deprecated') ||
		lower.includes('model_not_found')
	) {
		return 'model_deprecated';
	}
	if (status === 401 || status === 403) return 'auth_error';
	if (status === 429) return 'rate_limit';
	if (lower.includes('sentinel') || lower.includes('captcha')) return 'sentinel_error';
	if (status >= 500 && status < 600) return 'upstream_other';
	return 'upstream_other';
}

export function getLifecycle(model: string): {
	lifecycle: 'active' | 'deprecated' | 'unknown';
	deprecation_reason: string | null;
} {
	const known = KNOWN_DEPRECATED[model];
	if (known) return { lifecycle: 'deprecated', deprecation_reason: known };

	const fail = failureCache.get(model);
	if (fail) {
		const recent = Date.now() - fail.lastSeen < FAILURE_WINDOW_MS;
		const noSuccessSince = fail.lastSuccess < fail.lastSeen;
		// `model_deprecated` (410 / explicit message) → mark on a single
		// occurrence; it's a definitive signal. `upstream_other` (5xx) needs
		// the threshold to avoid one-off blips.
		if (recent && noSuccessSince && fail.kind === 'model_deprecated' && fail.count >= 1) {
			return {
				lifecycle: 'deprecated',
				deprecation_reason: `Reactive: upstream returned model_deprecated. Last error: ${fail.lastError.slice(0, 120)}`,
			};
		}
		if (recent && noSuccessSince && fail.count >= FAILURE_THRESHOLD) {
			return {
				lifecycle: 'deprecated',
				deprecation_reason: `Reactive: ${fail.count} consecutive ${fail.kind} responses. Last error: ${fail.lastError.slice(0, 120)}`,
			};
		}
		if (fail.lastSuccess > 0) return { lifecycle: 'active', deprecation_reason: null };
	}
	return { lifecycle: 'unknown', deprecation_reason: null };
}

export function _resetLifecycleCachesForTests(): void {
	failureCache.clear();
}
