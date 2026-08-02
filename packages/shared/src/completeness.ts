/**
 * Completeness Signalling
 *
 * A proxy route must report what it actually got. When an upstream API returns
 * a page of items alongside a total, the page is a fraction of the whole — and
 * a consumer reading `{ items: [...20], totalCount: 120 }` has no way to tell
 * "here are 20 of 120" from "here are all 20 matches out of a 120-item
 * catalogue." Many upstream APIs never say which, because their own client
 * already knows.
 *
 * `withCompleteness` derives the missing signal and stamps it on, so a
 * pass-through route stays honest without every handler re-deriving it. It
 * never overwrites a signal the upstream already sent — an upstream `hasMore`
 * is authoritative, because it knows things a count comparison cannot.
 *
 * Usage:
 *   import { withCompleteness } from '@interceptor/shared';
 *
 *   const body = await res.json();
 *   return c.json(withCompleteness(body));
 *
 * The mirror of this is the `completeness` check in scripts/route-spec.mjs,
 * which is a deliberately independent implementation: a checker that shared
 * code with the thing it checks could not catch a bug in the shared part.
 *
 * @module shared/completeness
 */

/** Field names upstream APIs use for "here are the items". */
const ITEM_KEYS = ['items', 'data', 'results', 'entries', 'records', 'rows', 'products', 'list'];

/** Field names upstream APIs use for "this is how many exist". */
const TOTAL_KEYS = ['total', 'totalCount', 'total_count', 'totalItems', 'totalResults', 'count'];

/** Signals whose presence means the upstream already told the truth. */
const DECLARED_KEYS = [
	'hasMore',
	'has_more',
	'nextCursor',
	'next_cursor',
	'nextPage',
	'complete',
	'incomplete',
	'truncated',
];

/** What a body says about its own completeness. */
export interface CompletenessSignal {
	/** Items present in this response. */
	returned: number;
	/** Items the upstream says exist, when it said. */
	indicatedTotal?: number;
	/** True when items remain beyond this response. */
	hasMore: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Derive the completeness signal for a response body.
 *
 * Returns null when the body carries no item collection with an indicated
 * total — there is nothing to be incomplete about, and inventing a signal
 * would be worse than staying silent.
 */
export function deriveCompleteness(body: unknown): CompletenessSignal | null {
	if (!isRecord(body)) return null;

	const items = ITEM_KEYS.map((k) => body[k]).find(Array.isArray) as unknown[] | undefined;
	if (!items) return null;

	const totalKey = TOTAL_KEYS.find((k) => typeof body[k] === 'number');
	if (!totalKey) return null;

	const indicatedTotal = body[totalKey] as number;
	return { returned: items.length, indicatedTotal, hasMore: items.length < indicatedTotal };
}

/**
 * Stamp a completeness signal onto a pass-through response body.
 *
 * A body the upstream already annotated is returned untouched. A body with no
 * item collection or no indicated total is returned untouched — this adds a
 * signal it can justify, never a guess.
 */
export function withCompleteness<T>(body: T): T {
	if (!isRecord(body)) return body;

	// The upstream knows more than a count comparison does. Defer to it.
	const alreadyDeclared = DECLARED_KEYS.some(
		(k) => body[k] !== undefined && body[k] !== null && body[k] !== false,
	);
	if (alreadyDeclared) return body;

	const signal = deriveCompleteness(body);
	if (!signal) return body;

	return { ...body, hasMore: signal.hasMore, returned: signal.returned } as T;
}
