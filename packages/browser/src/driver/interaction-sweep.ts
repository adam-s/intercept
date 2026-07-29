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
 * scroll, type, query, filter, play, expand, activate — chosen because each one
 * is the *cheapest known trigger* for a transport class, not because any
 * particular site wants them. No selectors from a target, no model judgment at
 * runtime: the same sweep runs everywhere, which is what makes results
 * comparable between sites.
 *
 * Four of them exist because the transport is otherwise unreachable rather than
 * merely less likely. A search endpoint is not called until something submits
 * the query, so typing alone finds the typeahead and never the search. A sort
 * dropdown refetches on change and nothing else touches it. A player asks for
 * no manifest and no segment until something plays it, so a video page captured
 * passively shows a page with no video in it. And a form names its parameters
 * only on submission — the URL is visible from the markup, the fields it wants
 * are not.
 *
 * Bounds are the whole safety story here, because this drives a real browser at
 * a real site: a hard cap on actions, a wall-clock ceiling, and same-origin
 * only. What decides whether a control may be activated is the HTTP method it
 * carries, not the word on it — GET is defined as safe, so a search form is
 * submitted and a POST form is not, on sites whose buttons say nothing legible
 * as well as on sites whose buttons say "Delete". The sweep returns to the
 * start URL whenever a provocation navigates away.
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
	// Raised with the provocations that wait on a result rather than on a
	// repaint: a query needs its round trip, a player needs a moment to reach
	// for its first segment. Under the old ceiling those ran last and were cut
	// by the deadline, which reported them as performed-then-nothing-found.
	maxMs: 90_000,
	maxPerSelector: 3,
	dwellMs: 4_000,
};

/** One provocation. `why` names the transport class it exists to trigger. */
export interface SweepAction {
	kind:
		| 'dwell'
		| 'scroll'
		| 'click'
		| 'type'
		| 'query'
		| 'hover'
		| 'key'
		| 'submit'
		| 'select'
		| 'media';
	/** CSS selector for element-targeted actions. */
	selector?: string;
	value?: string;
	why: string;
}

/**
 * Whether a form may be submitted.
 *
 * HTTP already answers this, and its answer beats any word list: GET is defined
 * as safe and idempotent, so submitting a GET form asks a question, while POST
 * and friends are how a site is told to change something. That is a property of
 * the request, so it holds on sites whose buttons say "Go", "Find", or nothing
 * at all — where a caption heuristic has nothing to read and guesses.
 *
 * The label check below still applies to controls that are *not* in a form,
 * because a bare button carries no method and its caption is the only signal
 * there is.
 */
export function isSafeFormMethod(method: string): boolean {
	return (
		String(method || 'GET')
			.trim()
			.toUpperCase() === 'GET'
	);
}

/**
 * Controls whose activation changes data rather than reading it. Matching is on
 * visible text and common attributes, and it is deliberately over-broad: a
 * skipped read is a small loss, a submitted form on someone's site is not.
 *
 * **This list is English, and that is a real limit — so it is the backstop and
 * never the primary guard.** A button reading "Löschen", "削除", or "Удалить" is
 * as destructive as "Delete" and matches nothing here. Two structural guards
 * carry the actual weight, and both are language-independent:
 *
 *   - HTTP method, for anything inside a form. GET asks, POST changes.
 *   - The activation selector itself, which is an allowlist of read-only ARIA
 *     semantics — a tab, a nav link, a disclosure, a `<summary>`, a button that
 *     controls another element. "Delete account" is not any of those in any
 *     language, so it is not matched in the first place.
 *
 * What remains uncovered is a bare non-English button that carries a read-only
 * ARIA role and is destructive anyway. That is a mislabelled control on the
 * site's part, and the residue is accepted rather than solved: closing it needs
 * either translation or a model call, and both cost more than the exposure.
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

/**
 * True when a control's label or attributes read as state-changing.
 *
 * Matched on whole words, not substrings. As substrings these words are far too
 * common to mean anything: on a site about posts, `post` matches
 * `post-thumbnail`, `postId`, and "Show 3 posts", and `report` matches
 * `reporting`. Measured on a live run, that made the backstop the primary guard
 * and refused ordinary read-only hovers — the opposite of the intent, since a
 * check that refuses everything stops discriminating.
 *
 * Multi-word entries still match as phrases; the boundary is applied at each
 * end rather than inside.
 */
export function isDestructive(label: string): boolean {
	const l = label.toLowerCase();
	// Hyphen and underscore count as *inside* a word, not as boundaries, because
	// the strings this has to survive are identifiers: `post-thumbnail` and
	// `post_id` are one word each, and treating `-` as a break put `post` back in
	// both. A space or punctuation is a real boundary.
	const EDGE = '[^a-z0-9_-]';
	return DESTRUCTIVE.some((w) => new RegExp(`(^|${EDGE})${w}(${EDGE}|$)`).test(l));
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
			why: 'typeahead fires on the first keystroke, and each field may have its own',
		},
		{
			kind: 'select',
			selector: 'select',
			why: 'sort and filter dropdowns refetch the list against new parameters',
		},
		{
			kind: 'media',
			selector: 'video, audio',
			why: 'a player fetches no manifest and no segment until something plays it',
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
		// The two provocations that navigate come last, and in this order.
		//
		// Anything that navigates ends the current document, which strands every
		// element still queued behind it. Run Enter as part of typing and the first
		// search box submits, the page moves, and the remaining fields are never
		// touched — measured: the site's second search box, a JavaScript one with
		// its own endpoint, was reached zero times out of one. Typing everywhere
		// first and querying afterwards costs nothing and loses nothing.
		{
			kind: 'query',
			selector: 'input[type=search], input[type=text], input[role=combobox]',
			value: 'a',
			why: 'a search endpoint is not called until something runs the query',
		},
		{
			kind: 'submit',
			selector: 'form',
			why: 'a search or filter form names its parameters only when it is submitted',
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
export interface ElementMeta {
	label: string;
	href: string;
	/** The form's method, or the control's own override. Empty outside a form. */
	formMethod: string;
	/**
	 * Where the owning form would send this, resolved absolute. Empty outside a
	 * form. A field carries no `href`, so this is the only thing that says where
	 * pressing Enter in it would go.
	 */
	formAction: string;
	/** The field announces itself as a query input, so Enter is safe to press. */
	isSearch: boolean;
	/** Free text. Enter in one of these can post to somebody's account. */
	isEditable: boolean;
}

export function elementMeta(el: Element): ElementMeta {
	// No nested function may appear in this body — not an arrow, not a helper,
	// however much repetition that costs. Under esbuild's `--keep-names`, which
	// tsx enables by default, every function expression is emitted wrapped in
	// `__name(...)`, and the wrapper lands *inside* this body while its
	// definition stays behind in module scope. The page then throws
	// `__name is not defined` on every element, the sweep records each one as
	// uninspectable, and it reports the dwells and scrolls it managed as though
	// it had run. A one-line `attr` helper cost six of seven provocations
	// exactly this way. `assertPageFunctionIsPortable` in the tests is the gate.
	// A <style> or <script> is not a control, and reading its text as a label
	// judged a stylesheet's own class names as a caption — `.post-thumbnail`
	// vetoed a read-only hover. Its text is code, so it carries no label at all.
	const tag = el.tagName.toLowerCase();
	const textual = tag === 'style' || tag === 'script' || tag === 'template' ? '' : undefined;

	const label = [
		textual ?? (el as HTMLElement).innerText,
		el.getAttribute('aria-label') || '',
		el.getAttribute('title') || '',
		el.getAttribute('name') || '',
		// `type` is deliberately absent. Reading it put the word "submit" into the
		// label of every explicit submit button, and the caption check then skipped
		// the search button on essentially every site. Form safety is now decided
		// by the method below, which is the property that actually says whether the
		// request asks or changes — so the attribute has nothing left to add here.
	]
		.filter(Boolean)
		.join(' ')
		.slice(0, 120);

	// A control's own override wins over its form's, the way the browser reads it.
	const owner = el.closest('form') as HTMLFormElement | null;
	const formMethod = el.getAttribute('formmethod') || (owner ? owner.method || 'get' : '');
	// `action` resolves to an absolute URL, and an empty attribute resolves to the
	// current document — so a form with no action reads as same-origin, correctly.
	const formAction = el.getAttribute('formaction') || (owner ? owner.action || '' : '');

	const hay = [
		el.getAttribute('type') || '',
		el.getAttribute('name') || '',
		el.getAttribute('id') || '',
		el.getAttribute('role') || '',
		el.getAttribute('placeholder') || '',
		el.getAttribute('aria-label') || '',
	]
		.join(' ')
		.toLowerCase();
	return {
		label,
		href: el.getAttribute('href') || '',
		formMethod,
		formAction,
		// A field that announces itself as a query input. Enter is safe to press
		// in one of these and unsafe in a free-text box, which is the whole reason
		// the distinction is drawn.
		isSearch: /\bsearch\b|\bquery\b|combobox|(^|\s)q(\s|$)/.test(hay),
		isEditable:
			el.getAttribute('contenteditable') === 'true' || el.tagName.toLowerCase() === 'textarea',
	};
}

/**
 * Bound one driver call in wall-clock time.
 *
 * The action cap and the deadline are only consulted *between* steps, so they
 * bound a sweep that keeps returning and do nothing for one that stops
 * returning. Several driver calls can wait far longer than the whole sweep is
 * allowed to take: Playwright's actionability checks default to thirty seconds
 * each, and a handle whose document was replaced mid-action can wait on a
 * context that will never answer. One of those turns a bounded sweep into a
 * hung process — no output, no partial result, nothing to read, which is
 * strictly worse than a failure.
 *
 * So every call that touches the browser goes through here. The loser of the
 * race is recorded as a skip with its reason, which keeps a stall legible
 * instead of fatal.
 */
async function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** How long any single driver call may take before it is abandoned. */
const CALL_TIMEOUT_MS = 5_000;

/**
 * What an element that could not be inspected looks like.
 *
 * Every field is present and inert, so a caller that forgets to check `__error`
 * gets the conservative answer rather than a crash — no label to match, no form
 * method, not a search field. The previous version cast the failure to `never`,
 * which erased the shape and let the entire guard below type-check against an
 * empty object.
 */
function uninspectable(reason: string): ElementMeta & { __error: string } {
	return {
		label: '',
		href: '',
		formMethod: '',
		formAction: '',
		isSearch: false,
		isEditable: true,
		__error: reason,
	};
}

/**
 * Run the sweep against a page, returning what it actually did.
 *
 * Every step is individually guarded: a selector that matches nothing, an
 * element that detaches mid-action, a click that opens a dialog, or a call that
 * simply never returns must not end the sweep, because the sweep's value is
 * cumulative and one bad element should not cost the remaining provocations.
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

	const origin = await bounded<string>(
		p.evaluate('location.origin'),
		CALL_TIMEOUT_MS,
		'read origin',
	).catch(() => '');
	const startUrl = await bounded<string>(
		p.evaluate('location.href'),
		CALL_TIMEOUT_MS,
		'read start url',
	).catch(() => '');

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
				await bounded(
					p.evaluate(
						action.value === 'bottom'
							? 'window.scrollTo(0, document.body.scrollHeight)'
							: 'window.scrollTo(0, 0)',
					),
					CALL_TIMEOUT_MS,
					'scroll',
				);
				await p.waitForTimeout(800);
				performed.push(action);
			} else if (action.kind === 'key') {
				await bounded(p.keyboard.press(String(action.value)), CALL_TIMEOUT_MS, 'key press');
				await p.waitForTimeout(600);
				performed.push(action);
			} else if (action.selector) {
				// biome-ignore lint/suspicious/noExplicitAny: Playwright handles, structurally typed
				let handles: any[] = await bounded<any[]>(
					p.$$(action.selector),
					CALL_TIMEOUT_MS,
					`query ${action.selector}`,
				).catch(() => []);

				// Running a query on a field inside a form submits it and leaves the
				// page; on a field with no form it fires a request and stays put. Both
				// are worth having, and only one order gets both — measured, the site's
				// form search went first, navigated, and the JavaScript search box next
				// to it was reached zero times. Document order is not meaningful here,
				// so ordering by what survives costs nothing.
				if (action.kind === 'query') {
					const scored = await Promise.all(
						handles.map(async (h) => ({
							h,
							navigates: await bounded<boolean>(
								h.evaluate((el: Element) => !!el.closest('form')),
								CALL_TIMEOUT_MS,
								'form membership',
							).catch(() => true),
						})),
					);
					handles = [
						...scored.filter((s) => !s.navigates),
						...scored.filter((s) => s.navigates),
					].map((s) => s.h);
				}
				let used = 0;
				for (const h of handles) {
					if (used >= cfg.maxPerSelector || !budgetLeft()) break;
					// The failure shape is part of the type, so the guard below reads it
					// rather than discovering it. Typed as `never` before, which erased
					// every field and let the whole block compile against `{}`.
					const meta: ElementMeta & { __error?: string } = await bounded<ElementMeta>(
						h.evaluate(elementMeta),
						CALL_TIMEOUT_MS,
						'inspect element',
					).catch((err: unknown) => uninspectable(String(err).slice(0, 120)));
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
					//
					// Inside a form, the form's method decides: HTTP says GET asks and
					// POST changes, and that is a fact about the request rather than a
					// guess from the caption. Outside a form there is no method to read,
					// so the caption is all that is left.
					const unsafe = meta.formMethod
						? !isSafeFormMethod(meta.formMethod)
						: isDestructive(meta.label);
					if (unsafe) {
						const why = meta.formMethod
							? `${meta.formMethod.toUpperCase()} form`
							: 'reads as state-changing';
						skipped.push(`${action.kind} "${meta.label.slice(0, 40) || '(unlabelled)'}": ${why}`);
						continue;
					}
					// Off-origin navigation leaves the target entirely; the capture
					// after it would describe a different site.
					//
					// Both doors, checked in one place. A link announces its destination
					// in `href`; a field announces nothing at all, and the place it would
					// send you is its form's action. Guarding only the first let a search
					// field pass — the sweep pressed Enter, the browser left the target,
					// a query string reached a third party, and that third party's own
					// document then entered the manifest as evidence about the site we
					// were measuring. `submit` had this check and `query` reached the
					// same form by a different door, which is exactly why it belongs on
					// the element rather than inside one action.
					const leavesOrigin = [meta.href, meta.formAction].some(
						(u) => u && origin && /^https?:/i.test(u) && !u.startsWith(origin),
					);
					if (leavesOrigin) {
						skipped.push(
							`${action.kind} "${meta.label.slice(0, 40) || '(unlabelled)'}": off-origin`,
						);
						continue;
					}

					if (action.kind === 'click') {
						await bounded(
							h.click({ timeout: 2_000, noWaitAfter: true }),
							CALL_TIMEOUT_MS,
							'click',
						).catch(() => {});
					} else if (action.kind === 'hover') {
						await bounded(h.hover({ timeout: 2_000 }), CALL_TIMEOUT_MS, 'hover').catch(() => {});
					} else if (action.kind === 'type' || action.kind === 'query') {
						await bounded(
							h.click({ timeout: 2_000, noWaitAfter: true }),
							CALL_TIMEOUT_MS,
							'focus field',
						).catch(() => {});
						await bounded(
							p.keyboard.type(String(action.value ?? 'a'), { delay: 120 }),
							CALL_TIMEOUT_MS,
							'type',
						).catch(() => {});

						// Typing reveals the typeahead endpoint. Running the query reveals
						// the search endpoint, which is a different endpoint on most sites
						// and the only one anybody actually wants — and on a site whose
						// search is JavaScript rather than a form, Enter is the sole thing
						// that ever asks for it.
						//
						// Enter goes only where the field says it takes a query: inside a
						// GET form, or a control announcing itself as search or combobox.
						// Never into free text, where a composer that submits on Enter
						// would post to somebody's account.
						if (action.kind === 'query') {
							const takesEnter = meta.isEditable
								? false
								: meta.formMethod
									? isSafeFormMethod(meta.formMethod)
									: meta.isSearch;
							if (takesEnter) {
								await bounded(p.keyboard.press('Enter'), CALL_TIMEOUT_MS, 'Enter').catch(() => {});
								await p.waitForTimeout(1_200);
							} else {
								skipped.push(
									`query "${meta.label.slice(0, 40) || '(unlabelled)'}": not a query field`,
								);
							}
						}
					} else if (action.kind === 'select') {
						// Playwright's own option setter, because assigning `value` and
						// dispatching `change` by hand is exactly what component
						// frameworks ignore — they read from their own value tracker, so
						// the hand-rolled version updates the DOM and refetches nothing.
						await bounded(
							h.selectOption({ index: 1 }, { timeout: 2_000 }),
							CALL_TIMEOUT_MS,
							'select option',
						).catch(() => {});
					} else if (action.kind === 'media') {
						// Muted, because muted playback is what autoplay policy permits
						// without a gesture, and because the transport is the point — the
						// segments are identical either way and nobody wants the audio.
						await bounded(
							h.evaluate((el: HTMLMediaElement) => {
								el.muted = true;
								return el.play?.();
							}),
							CALL_TIMEOUT_MS,
							'play media',
						).catch(() => {});
						await p.waitForTimeout(2_500);
					} else if (action.kind === 'submit') {
						// The off-origin check used to live here and nowhere else, which is
						// how pressing Enter in a field reached a form that this refused.
						// `meta.formAction` carries it for every interaction now.
						//
						// `requestSubmit` is the button's path, not the script's: it runs
						// validation and fires the submit event, so a required-but-empty
						// field silently cancels it. Filling the empties first is what
						// makes the provocation land rather than quietly do nothing.
						await bounded(
							h.evaluate((f: HTMLFormElement) => {
								for (const el of Array.from(f.elements)) {
									const i = el as HTMLInputElement;
									if (/^(text|search|email|number|tel|url)$/.test(i.type) && !i.value)
										i.value = 'a';
								}
								f.requestSubmit();
							}),
							CALL_TIMEOUT_MS,
							'submit form',
						).catch(() => {});
						await p.waitForTimeout(1_200);
					}
					await p.waitForTimeout(700);
					performed.push({ ...action, selector: `${action.selector} [${used}]` });
					used += 1;

					// A provocation that navigated has destroyed the document these
					// handles came from. Touching another one asks the browser to adopt a
					// node from a context that no longer exists, and the rejection for
					// that arrives from inside the driver rather than from the call —
					// which crashed the run outright rather than being caught here.
					// Submitting a search form is the ordinary case, not an edge one.
					const movedOn = await bounded(
						p.evaluate('location.href'),
						CALL_TIMEOUT_MS,
						'location check',
					).catch(() => startUrl);
					if (startUrl && movedOn !== startUrl) {
						skipped.push(`${action.kind} ${action.selector}: navigated, remaining matches stale`);
						break;
					}
				}
				if (!handles.length) skipped.push(`${action.kind} ${action.selector}: no match`);
			}
		} catch (err) {
			skipped.push(`${action.kind} ${action.selector ?? ''}: ${String(err).slice(0, 80)}`);
		}

		// A provocation that navigated costs every later one its context.
		try {
			const here = await bounded(p.evaluate('location.href'), CALL_TIMEOUT_MS, 'location check');
			if (startUrl && here !== startUrl) {
				await bounded(
					p.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }),
					20_000,
					'return to start',
				);
			}
		} catch {
			/* navigation check is best-effort */
		}
	}

	return { performed, skipped };
}
