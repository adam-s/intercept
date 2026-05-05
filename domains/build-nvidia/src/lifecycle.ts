/**
 * Model lifecycle detection for build-nvidia.
 *
 * NVIDIA's catalog lists models that have had their predict endpoint silently
 * removed — a chat completion against them returns
 * `{statusCode: "INTERNAL_ERROR", statusDescription: "Empty body"}` even though
 * /catalog still flags them as available. The user observed this on
 * `qwen/qwen3.5-122b-a10b`.
 *
 * Detection is hybrid:
 * 1. **Static known-bad list** — empirically verified models. Update when found.
 * 2. **Queue endpoint probe** — `/v2/predict/queues/models/<slug>` returns 404
 *    `{statusCode: "NOT_FOUND"}` for retired models. This is the cheap, reliable
 *    pre-call signal. No captcha required, no upstream-side cost.
 * 3. **Reactive failure cache** — predict-route handlers call
 *    `recordPredictResult` after every upstream call. After ≥ 2 gateway-side
 *    failures (INTERNAL_ERROR, function_not_found) within 24h with no success
 *    in between, the model is marked deprecated. Captcha and network errors
 *    are ignored (transient, not dispositive).
 *
 * @module domain-build-nvidia/lifecycle
 */

import { rateLimitedFetch } from '@interceptor/shared';

/**
 * Models confirmed dead — their predict endpoint returns INTERNAL_ERROR despite
 * the catalog listing them as available. Update entries when verified. The
 * reason is human-readable and surfaces in /v1/models so callers know why.
 */
export const KNOWN_DEPRECATED: Record<string, string> = {
	'qwen/qwen3.5-122b-a10b':
		'Predict endpoint removed by NVIDIA — queue probe returns 404 "NVCF function not found". Use nvidia/qwen/qwen3.5-397b-a17b.',
};

const NGC_API = 'https://api.ngc.nvidia.com/v2';
const NIM_ORG = 'qc69jvmznzxy';
const QUEUE_PROBE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const FAILURE_THRESHOLD = 2; // gateway-side failures before marking deprecated

type FailureKind =
	| 'gateway_internal_error' // INTERNAL_ERROR / Empty body — likely dead
	| 'function_not_found' // 404 from predict — definitely dead
	| 'captcha_error' // ignored — transient
	| 'network_error' // ignored — transient
	| 'upstream_other'; // 5xx other — counted but not dispositive

interface FailureRecord {
	kind: FailureKind;
	count: number;
	lastSeen: number; // unix ms
	lastError: string;
	lastSuccess: number; // unix ms; resets failure count when newer than lastSeen
}

interface QueueProbe {
	result: 'active' | 'deprecated';
	reason: string | null;
	checkedAt: number;
}

const failureCache = new Map<string, FailureRecord>();
const queueProbeCache = new Map<string, QueueProbe>();

/**
 * Record the outcome of a predict-route upstream call. The lifecycle module
 * uses this to detect models that respond with gateway-side errors despite
 * being listed in the catalog as available. Pure side-effect on cache.
 */
export function recordPredictResult(
	slug: string,
	opts: { ok: boolean; status: number; bodyPreview?: string },
): void {
	const now = Date.now();
	if (opts.ok) {
		// Successful call resets the failure record for this slug.
		const r = failureCache.get(slug);
		if (r) r.lastSuccess = now;
		else
			failureCache.set(slug, {
				kind: 'gateway_internal_error',
				count: 0,
				lastSeen: 0,
				lastError: '',
				lastSuccess: now,
			});
		return;
	}
	const kind = classifyFailure(opts.status, opts.bodyPreview ?? '');
	if (kind === 'captcha_error' || kind === 'network_error') return; // transient — ignore
	const existing = failureCache.get(slug) ?? {
		kind,
		count: 0,
		lastSeen: 0,
		lastError: '',
		lastSuccess: 0,
	};
	// If a success arrived more recently than the last failure, reset the count.
	if (existing.lastSuccess > existing.lastSeen) existing.count = 0;
	existing.kind = kind;
	existing.count += 1;
	existing.lastSeen = now;
	existing.lastError = (opts.bodyPreview ?? '').slice(0, 300);
	failureCache.set(slug, existing);
}

function classifyFailure(status: number, body: string): FailureKind {
	const lower = body.toLowerCase();
	if (status === 404 || lower.includes('not_found') || lower.includes('function not found')) {
		return 'function_not_found';
	}
	if (status === 500 && (lower.includes('internal_error') || lower.includes('empty body'))) {
		return 'gateway_internal_error';
	}
	if (status === 400 && lower.includes('captcha')) return 'captcha_error';
	if (status >= 500 && status < 600) return 'upstream_other';
	return 'upstream_other';
}

/**
 * Probe `/v2/predict/queues/models/<slug>` to determine whether the model's
 * NVCF function is registered. 404 with "NVCF function ... not found" means
 * the model has been retired from NVIDIA's gateway — even if /catalog still
 * lists it. 200 means the function exists (status may be ACTIVE or scaling).
 *
 * Caches results for 6h. The probe makes one HTTP GET; no captcha required.
 */
export async function probeQueue(slug: string): Promise<QueueProbe> {
	const now = Date.now();
	const cached = queueProbeCache.get(slug);
	if (cached && now - cached.checkedAt < QUEUE_PROBE_TTL_MS) return cached;
	let probe: QueueProbe;
	try {
		const res = await rateLimitedFetch(
			`${NGC_API}/predict/queues/models/${NIM_ORG}/${encodeURIComponent(slug)}`,
		);
		if (res.status === 404) {
			const text = await res.text().catch(() => '');
			probe = {
				result: 'deprecated',
				reason: text.includes('not found')
					? 'Queue probe: NVCF function not registered (model retired by NVIDIA)'
					: `Queue probe returned 404`,
				checkedAt: now,
			};
		} else if (res.ok) {
			probe = { result: 'active', reason: null, checkedAt: now };
		} else {
			// 5xx, transient — don't poison the cache long; mark active so we
			// retry on the next /v1/models call after TTL.
			probe = { result: 'active', reason: null, checkedAt: now - QUEUE_PROBE_TTL_MS + 30_000 };
		}
	} catch {
		// Network error — same fallback as above.
		probe = { result: 'active', reason: null, checkedAt: now - QUEUE_PROBE_TTL_MS + 30_000 };
	}
	queueProbeCache.set(slug, probe);
	return probe;
}

/**
 * Trigger a background probe of all slugs (capped concurrency). Returns
 * immediately; results land in the queueProbeCache. Subsequent
 * `getLifecycle` calls see the freshest data. Idempotent: re-probing
 * within the TTL is a no-op per slug.
 */
export async function probeAllQueues(slugs: string[], concurrency = 10): Promise<void> {
	const queue = [...slugs];
	const workers: Promise<void>[] = [];
	for (let i = 0; i < concurrency; i++) {
		workers.push(
			(async () => {
				while (queue.length > 0) {
					const slug = queue.shift();
					if (!slug) return;
					await probeQueue(slug).catch(() => undefined);
				}
			})(),
		);
	}
	await Promise.all(workers);
}

/** Returns the synchronous lifecycle verdict for a slug. Combines the
 *  static known-bad list, the cached queue probe, and the reactive
 *  failure cache. */
export function getLifecycle(slug: string): {
	lifecycle: 'active' | 'deprecated' | 'unknown';
	deprecation_reason: string | null;
} {
	const known = KNOWN_DEPRECATED[slug];
	if (known) return { lifecycle: 'deprecated', deprecation_reason: known };

	const queue = queueProbeCache.get(slug);
	if (queue?.result === 'deprecated') {
		return { lifecycle: 'deprecated', deprecation_reason: queue.reason };
	}

	const fail = failureCache.get(slug);
	if (fail) {
		const recent = Date.now() - fail.lastSeen < FAILURE_WINDOW_MS;
		const noSuccessSince = fail.lastSuccess < fail.lastSeen;
		if (recent && noSuccessSince && fail.count >= FAILURE_THRESHOLD) {
			return {
				lifecycle: 'deprecated',
				deprecation_reason: `Reactive: ${fail.count} consecutive ${fail.kind} responses. Last error: ${fail.lastError.slice(0, 100)}`,
			};
		}
	}

	if (queue?.result === 'active') return { lifecycle: 'active', deprecation_reason: null };
	return { lifecycle: 'unknown', deprecation_reason: null };
}

/** Test helper: clear all caches. Not used in production. */
export function _resetLifecycleCachesForTests(): void {
	failureCache.clear();
	queueProbeCache.clear();
}
