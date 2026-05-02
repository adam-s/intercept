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
import { plugin as buildNvidia } from '@interceptor/domain-build-nvidia';
import { plugin as chatgpt } from '@interceptor/domain-chatgpt';
import { registerRateLimit } from '@interceptor/shared';

// ─── Domain plugins ──────────────────────────────────────────────────

registerDomain(boardshop);
registerDomain(buildNvidia);
registerDomain(chatgpt);

// ─── Outbound rate limits (per-hostname) ─────────────────────────────

registerRateLimit('api.boardshop.example.com', { maxPerMinute: 30, retryOn429: 2 });
// build-nvidia: be conservative on the public NIM catalog endpoints
registerRateLimit('api.ngc.nvidia.com', { maxPerMinute: 60, retryOn429: 2 });
registerRateLimit('build.nvidia.com', { maxPerMinute: 60, retryOn429: 2 });
registerRateLimit('integrate.api.nvidia.com', { maxPerMinute: 30, retryOn429: 2 });
