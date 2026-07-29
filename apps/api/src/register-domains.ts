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
// Revised 2026-07-29 on further evidence, and the direction of the revision is
// the point: 20/min with 3s spacing was still too fast. A fourteen-route
// assertion run lands ~17 requests inside a minute, which is nominally under the
// ceiling and in practice a burst — and after several such runs the host was
// still refusing user pages an hour later while serving the front page fine.
// Two lessons, both general. A ceiling a normal run sits just beneath is not a
// ceiling. And an assertion suite is itself a traffic source: checking a small
// host repeatedly is indistinguishable, from that host's side, from crawling it.
// So the assert for this domain is slow by design — a couple of minutes — because
// a check that trips the limit has stopped measuring the routes and started
// measuring our own footprint.
registerRateLimit('news.ycombinator.com', {
	maxPerMinute: 10,
	maxConcurrent: 1,
	minSpacingMs: 6_000,
	retryOn429: 0,
});
// The credential harvest for the search route. One request per process in the
// common case; the ceiling covers a key rotation re-harvesting under load.
registerRateLimit('hn.algolia.com', { maxPerMinute: 10, maxConcurrent: 1, retryOn429: 0 });
