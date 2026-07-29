/**
 * Bounded Interaction Sweep
 *
 * Passive browsing observes the transports a page opens on load, and that is a
 * minority of what it has. Chat sockets open when a chat panel mounts, typeahead
 * fires on the first keystroke, pagination fires at the scroll boundary, and
 * polling only shows a period if you stay long enough to see it twice. A
 * capture taken from a page that was merely loaded reports those as absent, and
 * absent-because-unexercised is indistinguishable from absent-because-missing.
 *
 * So the sweep is a fixed, ordered list of generic provocations — dwell,
 * scroll, type, expand, activate — chosen because each one is the *cheapest
 * known trigger* for a transport class, not because any particular site wants
 * them. No selectors from a target, no model judgment at runtime: the same
 * sweep runs everywhere, which is what makes results comparable between sites.
 *
 * Bounds are the whole safety story here, because this drives a real browser at
 * a real site: a hard cap on actions, a wall-clock ceiling, and same-origin
 * only. Activating a control can submit or navigate, so the sweep never touches
 * anything that reads as destructive and returns to the start URL if a click
 * navigates away.
 *
 * @module browser/driver/interaction-sweep
 */

import type { DriverPage } from './types.js';

/** The bounds a caller may tighten. Widening one is possible and deliberate. */
export interface SweepLimits {
	/** Total provocations attempted, across every selector. */
	maxActions: number;
	/** Wall-clock ceiling for the whole sweep. */
	maxMs: number;
	/** Matches touched per selector, so one broad selector cannot eat the budget. */
	maxPerSelector: number;
	/** How long each dwell waits for late sockets and the second polling tick. */
	dwellMs: number;
}

/** Hard bounds. Stated here and enforced below — see AGENTS.md on bounded scripts. */
export const SWEEP_LIMITS: SweepLimits = {
	maxActions: 40,
	maxMs: 45_000,
	maxPerSelector: 3,
	dwellMs: 4_000,
};

/** One provocation. `why` names the transport class it exists to trigger. */
export interface SweepAction {
	kind: 'dwell' | 'scroll' | 'click' | 'type' | 'hover' | 'key';
	/** CSS selector for element-targeted actions. */
	selector?: string;
	value?: string;
	why: string;
}

/**
 * Controls whose activation changes data rather than reading it. Matching is on
 * visible text and common attributes, and it is deliberately over-broad: a
 * skipped read is a small loss, a submitted form on someone's site is not.
 */
export const DESTRUCTIVE = [
	'submit',
	'delete',
	'remove',
	'buy',
	'purchase',
	'checkout',
	'pay',
	'subscribe',
	'sign out',
	'log out',
	'logout',
	'unfollow',
	'report',
	'block',
	'upload',
	'post',
	'send',
	'confirm',
];

/** True when a control's label or attributes read as state-changing. */
export function isDestructive(label: string): boolean {
	const l = label.toLowerCase();
	return DESTRUCTIVE.some((w) => l.includes(w));
}

/**
 * The sweep, in order. Cheap and broad first, so a run that exhausts its budget
 * still spent it on the highest-yield provocations.
 *
 * Pure — returns a plan, runs nothing — so the ordering and the bounds are
 * testable without a browser.
 */
export function sweepPlan(): SweepAction[] {
	return [
		{
			kind: 'dwell',
			why: 'sockets and SSE open after mount; polling needs two ticks to show a period',
		},
		{ kind: 'scroll', value: 'bottom', why: 'infinite scroll and pagination fire at the boundary' },
		{ kind: 'scroll', value: 'top', why: 'some feeds refetch on return to top' },
		{
			kind: 'type',
			selector:
				'input[type=search], input[type=text], input[role=combobox], [contenteditable=true]',
			value: 'a',
			why: 'typeahead and suggest endpoints fire on the first keystroke',
		},
		{
			kind: 'hover',
			selector: 'a[href], [data-testid], article, [role=article]',
			why: 'hover cards and prefetch reveal detail endpoints',
		},
		{
			kind: 'click',
			selector:
				'[role=tab], nav a, [aria-expanded=false], summary, button[aria-controls], [data-testid*=tab]',
			why: 'tabs and disclosures mount panels that open their own transports',
		},
		{ kind: 'key', value: 'End', why: 'keyboard paging reaches lists that ignore wheel events' },
		{ kind: 'dwell', why: 'a second dwell catches the polling interval and late sockets' },
	];
}

/**
 * Read the label and link off an element, in the page.
 *
 * Passed as a function, never as a string. A string handed to `evaluate` is
 * treated as an *expression*, so a stringified arrow function evaluates to a
 * function object rather than being called — and a function is not
 * serializable, so the result comes back `undefined`. That failure is silent
 * and total: every element inspection returned nothing, so every click and
 * every keystroke was skipped on every site, while the sweep reported the
 * dwells and scrolls it did manage and looked like it had run.
 */
function elementMeta(el: Element): { label: string; href: string } {
	const label = [
		(el as HTMLElement).innerText,
		el.getAttribute('aria-label'),
		el.getAttribute('title'),
		el.getAttribute('name'),
		// The attribute, not the property. A <button> with no type attribute
		// reports the property as "submit" by spec, so reading the property put
		// the word "submit" in the label of every plain button on every page and
		// the destructive check skipped all of them. An explicit type="submit" is
		// still read, which is the case worth catching.
		el.getAttribute('type'),
	]
		.filter(Boolean)
		.join(' ')
		.slice(0, 120);
	return { label, href: el.getAttribute('href') || '' };
}

/**
 * Run the sweep against a page, returning what it actually did.
 *
 * Every step is individually guarded: a selector that matches nothing, an
 * element that detaches mid-action, or a click that opens a dialog must not end
 * the sweep, because the sweep's value is cumulative and one bad element should
 * not cost the remaining provocations.
 */
export async function runSweep(
	page: DriverPage,
	limits: Partial<SweepLimits> = {},
): Promise<{ performed: SweepAction[]; skipped: string[] }> {
	const cfg = { ...SWEEP_LIMITS, ...limits };
	const deadline = Date.now() + cfg.maxMs;
	const performed: SweepAction[] = [];
	const skipped: string[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: Playwright page, structurally typed
	const p = page as any;

	const origin = await p.evaluate('location.origin').catch(() => '');
	const startUrl = await p.evaluate('location.href').catch(() => '');

	const budgetLeft = () => performed.length < cfg.maxActions && Date.now() < deadline;

	for (const action of sweepPlan()) {
		if (!budgetLeft()) {
			skipped.push(`${action.kind}: budget exhausted`);
			continue;
		}
		try {
			if (action.kind === 'dwell') {
				await p.waitForTimeout(cfg.dwellMs);
				performed.push(action);
			} else if (action.kind === 'scroll') {
				await p.evaluate(
					action.value === 'bottom'
						? 'window.scrollTo(0, document.body.scrollHeight)'
						: 'window.scrollTo(0, 0)',
				);
				await p.waitForTimeout(800);
				performed.push(action);
			} else if (action.kind === 'key') {
				await p.keyboard.press(String(action.value));
				await p.waitForTimeout(600);
				performed.push(action);
			} else if (action.selector) {
				const handles = await p.$$(action.selector).catch(() => []);
				let used = 0;
				for (const h of handles) {
					if (used >= cfg.maxPerSelector || !budgetLeft()) break;
					const meta = await h
						.evaluate(elementMeta)
						.catch((err: unknown) => ({ __error: String(err).slice(0, 120) }) as never);
					// A handle that cannot be inspected used to produce neither a
					// performed entry nor a skipped one: the provocation silently did
					// nothing and the report showed nothing, which is the failure this
					// whole module exists to remove one level down.
					if (!meta || (meta as { __error?: string }).__error) {
						skipped.push(
							`${action.kind} ${action.selector}: could not inspect element — ${(meta as { __error?: string })?.__error ?? 'no result'}`,
						);
						continue;
					}

					// The guards apply to every element interaction, not just `click`.
					// Typing reaches a control the same way clicking does — it focuses
					// it first — so a composer caught by the text-input selector would
					// otherwise be clicked and typed into with no check at all.
					if (isDestructive(meta.label)) {
						skipped.push(`${action.kind} "${meta.label.slice(0, 40)}": reads as state-changing`);
						continue;
					}
					// Off-origin navigation leaves the target entirely; the capture
					// after it would describe a different site.
					if (meta.href && origin && /^https?:/i.test(meta.href) && !meta.href.startsWith(origin)) {
						skipped.push(`${action.kind} "${meta.label.slice(0, 40)}": off-origin`);
						continue;
					}

					if (action.kind === 'click') {
						await h.click({ timeout: 2000, noWaitAfter: true }).catch(() => {});
					} else if (action.kind === 'hover') {
						await h.hover({ timeout: 2000 }).catch(() => {});
					} else if (action.kind === 'type') {
						await h.click({ timeout: 2000, noWaitAfter: true }).catch(() => {});
						await p.keyboard.type(String(action.value ?? 'a'), { delay: 120 });
					}
					await p.waitForTimeout(700);
					performed.push({ ...action, selector: `${action.selector} [${used}]` });
					used += 1;
				}
				if (!handles.length) skipped.push(`${action.kind} ${action.selector}: no match`);
			}
		} catch (err) {
			skipped.push(`${action.kind} ${action.selector ?? ''}: ${String(err).slice(0, 80)}`);
		}

		// A provocation that navigated costs every later one its context.
		try {
			const here = await p.evaluate('location.href');
			if (startUrl && here !== startUrl) {
				await p.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
			}
		} catch {
			/* navigation check is best-effort */
		}
	}

	return { performed, skipped };
}
