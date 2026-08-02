/**
 * InnerTube parsing, over the two renderer shapes that are in circulation.
 *
 * The payloads below are hand-built to the shapes recorded in the module's own
 * docblock, and each is deliberately partial: they carry the keys the parser
 * reads and nothing else, so a test passing says the parser found what it needed
 * in a realistic nesting rather than in a flat object made to suit it.
 *
 * What these pin, and why each one is a defect that reads as working data:
 * a card whose picture is missing renders as a card with no picture, which looks
 * like a video with no thumbnail; a live card's metadata says "watching" and
 * never "views", so a views matcher that misses it reports null and the row
 * reads as a video nobody has watched; and a total derived from the returned
 * count agrees with itself forever.
 */

import { describe, expect, it } from 'vitest';
import {
	collectRenderers,
	estimatedResults,
	hasContinuation,
	textOf,
	thumbnailOf,
	videoCards,
} from './innertube.js';

/** The long-standing shape: text in `runs`/`simpleText`, picture in `thumbnails`. */
const CLASSIC = {
	contents: {
		twoColumnSearchResultsRenderer: {
			primaryContents: {
				sectionListRenderer: {
					contents: [
						{
							itemSectionRenderer: {
								contents: [
									{
										videoRenderer: {
											videoId: 'aaaaaaaaaaa',
											title: { runs: [{ text: 'A classic card' }] },
											ownerText: { runs: [{ text: 'Some Channel' }] },
											publishedTimeText: { simpleText: '2 years ago' },
											viewCountText: { simpleText: '1.2M views' },
											lengthText: { simpleText: '3:07' },
											thumbnail: {
												thumbnails: [
													{ url: 'https://example.org/small.jpg', width: 120, height: 90 },
													{ url: 'https://example.org/large.jpg', width: 480, height: 360 },
												],
											},
										},
									},
								],
							},
						},
					],
				},
			},
		},
	},
	estimatedResults: '1240000',
};

/** The view-model shape: text in `content`, picture in `sources`, fewer fields. */
const MODERN = {
	contents: [
		{
			lockupViewModel: {
				contentId: 'bbbbbbbbbbb',
				contentImage: {
					thumbnailViewModel: {
						image: {
							sources: [{ url: 'https://example.org/modern.jpg', width: 720, height: 404 }],
						},
					},
				},
				metadata: {
					lockupMetadataViewModel: {
						title: { content: 'A view-model card' },
						metadata: {
							contentMetadataViewModel: {
								metadataRows: [
									{ metadataParts: [{ text: { content: '1.1K watching' } }] },
									{ metadataParts: [{ text: { content: '3 hours ago' } }] },
								],
							},
						},
					},
				},
			},
		},
		{ continuationItemRenderer: { trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN' } },
	],
};

describe('textOf', () => {
	it('flattens all three text shapes', () => {
		expect(textOf({ simpleText: 'a' })).toBe('a');
		expect(textOf({ content: 'b' })).toBe('b');
		expect(textOf({ runs: [{ text: 'c' }, { text: 'd' }] })).toBe('cd');
	});

	it('returns an empty string rather than throwing on an unknown shape', () => {
		expect(textOf(undefined)).toBe('');
		expect(textOf({ nope: 1 })).toBe('');
	});
});

describe('collectRenderers', () => {
	it('finds a node by type however deeply the surface nests it', () => {
		expect(collectRenderers(CLASSIC, 'videoRenderer')).toHaveLength(1);
	});

	it('is bounded against a cyclic payload', () => {
		const cyclic: Record<string, unknown> = { videoRenderer: { videoId: 'x' } };
		cyclic.self = cyclic;
		expect(() => collectRenderers(cyclic, 'videoRenderer')).not.toThrow();
	});
});

describe('thumbnailOf', () => {
	it('takes the widest entry, not the first', () => {
		expect(thumbnailOf(CLASSIC.contents)).toBe('https://example.org/large.jpg');
	});

	it('reads the view-model key as well as the classic one', () => {
		const card = MODERN.contents[0].lockupViewModel;
		expect(thumbnailOf(card?.contentImage)).toBe('https://example.org/modern.jpg');
	});

	it('returns null for a card that carries no picture, rather than a composed URL', () => {
		expect(thumbnailOf({ videoId: 'ccccccccccc' })).toBeNull();
		expect(thumbnailOf(undefined)).toBeNull();
	});

	it('ignores an entry with no url', () => {
		expect(thumbnailOf({ thumbnails: [{ width: 999 }] })).toBeNull();
	});
});

describe('videoCards', () => {
	it('reads the classic renderer whole', () => {
		const [card] = videoCards(CLASSIC);
		expect(card).toMatchObject({
			videoId: 'aaaaaaaaaaa',
			title: 'A classic card',
			channel: 'Some Channel',
			published: '2 years ago',
			views: '1.2M views',
			duration: '3:07',
			thumbnail: 'https://example.org/large.jpg',
			_renderer: 'videoRenderer',
		});
	});

	it('reads a live view-model card whose metadata says watching, not views', () => {
		const [card] = videoCards(MODERN);
		expect(card).toMatchObject({
			videoId: 'bbbbbbbbbbb',
			title: 'A view-model card',
			views: '1.1K watching',
			published: '3 hours ago',
			thumbnail: 'https://example.org/modern.jpg',
			_renderer: 'lockupViewModel',
		});
	});

	it('omits the fields the view-model surface does not carry, rather than emptying them', () => {
		const [card] = videoCards(MODERN);
		// Absent and empty are different claims: a consumer showing "by " for an
		// empty string is rendering a fact this surface never stated.
		expect(card.channel).toBeUndefined();
		expect(card.duration).toBeUndefined();
	});

	it('returns both shapes from one payload, de-duplicated by id', () => {
		const cards = videoCards({ a: CLASSIC, b: MODERN, c: MODERN });
		expect(cards.map((v) => v.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb']);
	});

	it('returns an empty list for a payload with no cards at all', () => {
		expect(videoCards({ contents: [] })).toEqual([]);
		expect(videoCards(null)).toEqual([]);
	});
});

describe('completeness inputs', () => {
	it('reads the upstream estimate, including as a string', () => {
		expect(estimatedResults(CLASSIC)).toBe(1_240_000);
		expect(estimatedResults({ estimatedResults: 42 })).toBe(42);
	});

	it('returns null when the upstream states no total', () => {
		// The route reports the absence. Substituting the returned count here is
		// what made the old signal unfalsifiable.
		expect(estimatedResults(MODERN)).toBeNull();
		expect(estimatedResults({ estimatedResults: 'lots' })).toBeNull();
		expect(estimatedResults(null)).toBeNull();
	});

	it('reports more-exists from the continuation, not from a count', () => {
		expect(hasContinuation(MODERN)).toBe(true);
		expect(hasContinuation(CLASSIC)).toBe(false);
	});
});
