/**
 * Gatedboard — every endpoint here is unreachable without an interaction.
 *
 * The calibration benchmark measures the *capture* layer: it fires one call per
 * egress primitive on load, so a score below 100% means a primitive is not
 * patched. It cannot measure the *interaction* layer at all, because a page
 * that calls everything on load needs nothing provoked — and that blind spot
 * hid a real defect for as long as it existed. The benchmark reached
 * `Form-encoded POST` through `form.submit()`, the one submission path a
 * prototype patch can see; the paths a person uses, a submit button and the
 * Enter key, never call that method and were captured nowhere. The bench read
 * 13/13 throughout.
 *
 * So this fixture inverts the design. Nothing is called on load beyond a single
 * baseline request, and each remaining endpoint answers exactly one provocation.
 * A capture taken from a merely loaded page must therefore score one out of
 * many here — if it scores more, the fixture has stopped being gated and is no
 * longer evidence about anything.
 *
 * Two readings are available and they answer different questions. The server's
 * own hit log says whether the interaction *happened*; the capture says whether
 * the instrument *saw* it. Both empty means the sweep never provoked the page;
 * hit log full and capture empty means the sweep works and the instrument is
 * blind to that primitive. Collapsing them into one number would make those two
 * failures indistinguishable, which is the failure this fixture exists to
 * prevent.
 *
 * @module test-server/sites/gatedboard
 */

import { Hono } from 'hono';

/**
 * Endpoint → the single provocation that reaches it. The sweep's plan is
 * written against transport classes; this is written against the same ground
 * from the other side, so a broken provocation names itself in the score
 * instead of showing up as a vague drop.
 */
export const GATED_ENDPOINTS: Record<string, string> = {
	'/search': 'submit — a GET search form, via its button or the Enter key',
	'/spa-search': 'type + Enter — a search box with no form around it',
	'/suggest': 'type — typeahead on the first keystroke',
	'/sort': 'select — a sort dropdown that refetches on change',
	'/media/clip.mp4': 'media — a player that requests nothing until it plays',
	'/panel': 'click — a tab that mounts its panel on activation',
	'/page2': 'scroll — the next page at the scroll boundary',
};

/** The one call that happens without any provocation, so absence is legible. */
export const GATEDBOARD_BASELINE = '/api/hello';

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>gatedboard</title></head>
<body>
<h1>Gatedboard</h1>
<p>Nothing here calls anything until it is provoked.</p>

<!-- A GET form. Safe by HTTP definition, and the only kind the sweep may submit. -->
<form id="searchform" method="get" action="./search">
	<input type="search" name="q" placeholder="Search decks">
	<button type="submit">Go</button>
</form>

<!-- The same job with no form at all, which is how most sites do it now.
     Only Enter reaches the query; typing alone reaches the typeahead. -->
<input id="spa" type="search" name="query" placeholder="Search (no form)">

<!-- A POST form, present so the guard has something it must refuse. Reaching
     this endpoint is a failure, not a finding. -->
<form id="dangerform" method="post" action="./destroy">
	<input type="hidden" name="confirm" value="yes">
	<button type="submit">Go</button>
</form>

<select id="sort">
	<option value="">Sort</option>
	<option value="price">Price</option>
</select>

<!-- preload=none is what makes this gated: the browser requests no bytes at
     all until something plays it. A player left alone is a page with no video
     in it as far as any capture can tell. -->
<video id="v" preload="none" width="160" muted>
	<source src="./media/clip.mp4" type="video/mp4">
</video>

<button id="tab" role="tab" aria-controls="panel">Details</button>
<div id="panel"></div>

<div id="feed" style="height:120vh">feed</div>

<script>
(() => {
	const go = (u) => fetch(u).catch(() => {});

	// The baseline. Its presence proves the page ran and the capture works, so a
	// zero score reads as "nothing was provoked" rather than "nothing was seen".
	go('./api/hello');

	const spa = document.getElementById('spa');
	spa.addEventListener('input', () => go('./suggest?q=' + encodeURIComponent(spa.value)));
	spa.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') go('./spa-search?q=' + encodeURIComponent(spa.value));
	});

	document.getElementById('sort').addEventListener('change', (e) => {
		go('./sort?by=' + encodeURIComponent(e.target.value));
	});

	document.getElementById('tab').addEventListener('click', () => go('./panel'));

	let paged = false;
	addEventListener('scroll', () => {
		if (paged) return;
		if (scrollY + innerHeight >= document.body.scrollHeight - 40) { paged = true; go('./page2'); }
	}, { passive: true });
})();
</script>
</body>
</html>`;

/**
 * The site, plus a hit log.
 *
 * The log is per-instance rather than module-level so two servers in one test
 * run cannot read each other's counts — a shared counter would make a passing
 * test depend on which file ran first.
 */
export function createGatedboardSite(): Hono {
	const app = new Hono();
	const hits: string[] = [];
	const log = (p: string) => {
		if (hits.length < 500) hits.push(p);
	};

	app.get('/', (c) => c.html(PAGE));

	/** What the page actually received. Ground truth for "did it fire". */
	app.get('/hits', (c) => c.json({ hits, unique: [...new Set(hits)].sort() }));
	app.post('/reset', (c) => {
		hits.length = 0;
		return c.json({ ok: true });
	});

	app.get('/api/hello', (c) => {
		log(GATEDBOARD_BASELINE);
		return c.json({ ok: true });
	});

	app.get('/search', (c) => {
		log('/search');
		return c.html(`<!doctype html><p>results for ${c.req.query('q') ?? ''}</p>`);
	});
	app.get('/spa-search', (c) => {
		log('/spa-search');
		return c.json({ results: [], q: c.req.query('q') ?? '' });
	});
	app.get('/suggest', (c) => {
		log('/suggest');
		return c.json({ suggestions: ['deck', 'deckchair'] });
	});
	app.get('/sort', (c) => {
		log('/sort');
		return c.json({ items: [], by: c.req.query('by') ?? '' });
	});
	app.get('/panel', (c) => {
		log('/panel');
		return c.json({ panel: 'details' });
	});
	app.get('/page2', (c) => {
		log('/page2');
		return c.json({ items: [], page: 2 });
	});

	// Eight bytes of nothing. The transport is the finding; the pixels are not.
	app.get('/media/clip.mp4', (c) => {
		log('/media/clip.mp4');
		return c.body(new Uint8Array(8), 200, { 'content-type': 'video/mp4' });
	});

	/**
	 * The endpoint that must never be reached. A POST form is how a site is told
	 * to change something, and a sweep that submits one has stopped being a
	 * reader. Logged rather than refused, because a guard proven by a 403 is a
	 * guard proven by the wrong party — this has to record that we asked.
	 */
	app.post('/destroy', (c) => {
		log('/destroy');
		return c.json({ destroyed: true });
	});

	return app;
}
