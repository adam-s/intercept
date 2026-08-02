/**
 * HTML parsing helpers for news.ycombinator.com's server-rendered markup.
 *
 * The site emits exactly one shared row shape for a "story" listing
 * (`tr.athing` immediately followed by a `tr` holding a `.subtext` cell) and
 * one shared row shape for a "comment" (`tr.athing.comtr`, holding a
 * `td.ind[indent]` that records nesting depth — the same field the site's
 * own `hn.js` reads via its `ind()` helper to walk the tree). Both listings
 * (front page, best, show, ask, a user's submissions) and both comment views
 * (an item's thread, a user's comment history) reuse these two shapes, so
 * one parser each covers every data type discovery found.
 *
 * @module domain-hackernews/parse
 */

import type { CheerioAPI } from 'cheerio';

export interface StoryRow {
	id: string;
	rank: number | null;
	title: string;
	url: string | null;
	site: string | null;
	points: number | null;
	author: string | null;
	ageISO: string | null;
	ageText: string | null;
	commentCount: number | null;
	commentsUrl: string | null;
}

/** Parse every `tr.athing` "story" row on a listing page (front page, best, submitted, ...). */
export function parseStoryRows($: CheerioAPI): StoryRow[] {
	const rows: StoryRow[] = [];
	$('tr.athing').each((_, el) => {
		const row = $(el);
		// Comment rows are also `tr.athing` (class="athing comtr") — skip those,
		// this parser is for story rows only (class="athing" or "athing submission").
		if (row.hasClass('comtr')) return;

		const id = row.attr('id') ?? '';
		const rankText = row.find('.rank').first().text().replace('.', '').trim();
		const rank = rankText ? Number(rankText) : null;
		const titleLink = row.find('.titleline > a').first();
		const title = titleLink.text().trim();
		const url = titleLink.attr('href') ?? null;
		const site = row.find('.sitestr').first().text().trim() || null;

		const subtext = row.next('tr').find('.subtext');
		const pointsText = subtext
			.find('.score')
			.first()
			.text()
			.replace(/[^0-9]/g, '');
		const points = pointsText ? Number(pointsText) : null;
		const author = subtext.find('.hnuser').first().text().trim() || null;
		const ageEl = subtext.find('.age').first();
		const ageISO = ageEl.attr('title')?.split(' ')[0] ?? null;
		const ageText = ageEl.text().trim() || null;

		// The last "item?id=" link in subtext is the comments link; its text is
		// either "N comments", "discuss", or absent (jobs listings carry neither).
		let commentCount: number | null = null;
		let commentsUrl: string | null = null;
		subtext.find('a').each((_i, a) => {
			const href = $(a).attr('href') ?? '';
			if (href.startsWith('item?id=')) {
				commentsUrl = href;
				const text = $(a).text().trim();
				const match = text.match(/^(\d+)/);
				commentCount = match ? Number(match[1]) : text === 'discuss' ? 0 : commentCount;
			}
		});

		rows.push({
			id,
			rank,
			title,
			url,
			site,
			points,
			author,
			ageISO,
			ageText,
			commentCount,
			commentsUrl,
		});
	});
	return rows;
}

export interface CommentNode {
	id: string;
	indent: number;
	author: string | null;
	ageISO: string | null;
	ageText: string | null;
	textHTML: string | null;
	deleted: boolean;
	onStoryTitle: string | null;
	onStoryUrl: string | null;
	children: CommentNode[];
}

/** Parse every `tr.athing.comtr` "comment" row on the page, flat, in document order. */
export function parseCommentRowsFlat($: CheerioAPI): Omit<CommentNode, 'children'>[] {
	const rows: Omit<CommentNode, 'children'>[] = [];
	$('tr.athing.comtr').each((_, el) => {
		const row = $(el);
		const id = row.attr('id') ?? '';
		const indentAttr = row.find('td.ind').first().attr('indent');
		const indent = indentAttr ? Number(indentAttr) : 0;
		const author = row.find('.hnuser').first().text().trim() || null;
		const ageEl = row.find('.age').first();
		const ageISO = ageEl.attr('title')?.split(' ')[0] ?? null;
		const ageText = ageEl.text().trim() || null;
		const commtext = row.find('.commtext').first();
		const textHTML = commtext.length ? (commtext.html() ?? null) : null;
		const deleted = !author && !textHTML;
		// Present only on a user's /threads page: which story this comment sits under.
		const onStory = row.find('.onstory a').first();
		const onStoryTitle = onStory.length ? onStory.text().trim() : null;
		const onStoryUrl = onStory.length ? (onStory.attr('href') ?? null) : null;

		rows.push({ id, indent, author, ageISO, ageText, textHTML, deleted, onStoryTitle, onStoryUrl });
	});
	return rows;
}

/**
 * Fold a flat, indent-ordered comment list into a tree.
 *
 * Mirrors the walk `hn.js` itself does client-side (`nextcomm`/`showkids`,
 * comparing each row's `indent` against its predecessor) — a comment is a
 * child of the nearest preceding row with a strictly smaller indent.
 */
export function buildCommentTree(flat: Omit<CommentNode, 'children'>[]): CommentNode[] {
	const roots: CommentNode[] = [];
	const stack: CommentNode[] = [];
	for (const c of flat) {
		const node: CommentNode = { ...c, children: [] };
		while (stack.length && stack[stack.length - 1].indent >= node.indent) stack.pop();
		if (stack.length === 0) {
			roots.push(node);
		} else {
			stack[stack.length - 1].children.push(node);
		}
		stack.push(node);
	}
	return roots;
}

/** Extract the `next=<id>&n=<rank>` (or bare `next=<id>`) cursor from a page's "More" link, if present. */
export function extractCursorNext($: CheerioAPI): { next: string; n: string | null } | null {
	const href = $('a.morelink').attr('href');
	if (!href) return null;
	const url = new URL(href, 'https://news.ycombinator.com/');
	const next = url.searchParams.get('next');
	if (!next) return null;
	return { next, n: url.searchParams.get('n') };
}

/** Extract the `?p=N` page number from a page's "More" link, if present. */
export function extractPageNext($: CheerioAPI): number | null {
	const href = $('a.morelink').attr('href');
	if (!href) return null;
	const url = new URL(href, 'https://news.ycombinator.com/');
	const p = url.searchParams.get('p');
	return p ? Number(p) : null;
}
