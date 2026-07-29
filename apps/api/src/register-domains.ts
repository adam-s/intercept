/**
 * Domain Registration & Rate Limits
 *
 * Imports and registers all domain plugins at application startup.
 * Also registers outbound rate limits for known external APIs.
 *
 * The browser handler uses getDomain() to look up plugins by name —
 * it has zero knowledge of which domains are registered.
 *
 * @module api/register-domains
 */

import { registerDomain } from '@interceptor/browser/handler/domain-loader';
import { plugin as boardshop } from '@interceptor/domain-boardshop';
import { plugin as hackernews } from '@interceptor/domain-hackernews';
import { plugin as reddit } from '@interceptor/domain-reddit';
import { plugin as twitch } from '@interceptor/domain-twitch';
import { plugin as yahoofinance } from '@interceptor/domain-yahoofinance';
import { plugin as youtube } from '@interceptor/domain-youtube';
import { registerRateLimit } from '@interceptor/shared';

// ─── Domain plugins ──────────────────────────────────────────────────

registerDomain(boardshop);
registerDomain(reddit);
registerDomain(twitch);
registerDomain(hackernews);
registerDomain(youtube);
registerDomain(yahoofinance);

// ─── Outbound rate limits (per-hostname) ─────────────────────────────

registerRateLimit('api.boardshop.example.com', { maxPerMinute: 30, retryOn429: 2 });
// Hacker News runs on one small server and answers a burst with a plain-text
// refusal rather than a status a parser notices. `retryOn429: 0` because a
// limit we caused is not a property of the site: re-sending the same request
// deepens our own footprint and teaches us nothing the first response did not
// already say. One route call is one upstream page, so this ceiling is a
// reader's pace, not a crawler's.
// Measured 2026-07-29: a discovery session that had already spent ~25 requests
// on the host drew a 429 from an archive page (`front?day=…&p=2`) at a nominal
// 20/min. The ceiling is 8 with one connection because that run's evidence says
// 20 was too fast for this host, not because 8 is a round number — and a limit
// this side caused is the kind that gets misfiled as the site's policy.
// `minSpacingMs` is the load-bearing one: a count alone let an assertion run
// send its first eight calls back to back and collect five refusals, because a
// sliding window constrains volume and says nothing about arrival rate.
registerRateLimit('news.ycombinator.com', {
	maxPerMinute: 20,
	maxConcurrent: 1,
	minSpacingMs: 3_000,
	retryOn429: 0,
});
// The credential harvest for the search route. One request per process in the
// common case; the ceiling covers a key rotation re-harvesting under load.
registerRateLimit('hn.algolia.com', { maxPerMinute: 10, maxConcurrent: 1, retryOn429: 0 });
