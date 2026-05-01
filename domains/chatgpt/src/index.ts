/**
 * ChatGPT Domain Plugin
 *
 * Privacy-first proxy for chatgpt.com.
 *
 * Primary capability: POST /api/chatgpt/chat — proxies ChatGPT's conversation API
 * and streams the SSE response through.
 *
 * Privacy layer: attach ChatGPTScriptInterceptor in 'control' mode to replace
 * the 55 properties Cloudflare Turnstile / ChatGPT Sentinel read with persona
 * data from a FingerprintProfile. Cloudflare's challenge token will contain your
 * chosen persona, not your real device fingerprint.
 *
 * USAGE
 * ─────
 * 1. Connect browser to chatgpt.com (logged in)
 * 2. POST /api/chatgpt/session/harvest → extracts Bearer token
 * 3. (Optional) PUT /api/chatgpt/fingerprint/profile → set persona
 * 4. (Optional) POST /api/chatgpt/fingerprint/attach { mode: 'control' }
 * 5. POST /api/chatgpt/chat { message: '...' } → streams response
 *
 * @module domain-chatgpt
 */

import type { DomainPlugin } from '@interceptor/browser/handler/domain-loader';
import type { InterceptorConfig } from '@interceptor/browser/shared/config';
import { GenericInterceptor } from '@interceptor/browser/shared/interceptor';
import type { Route } from 'patchright';
import { routes } from './routes';

const config: InterceptorConfig = {
	domainName: 'chatgpt',
	interceptPatterns: ['https://chatgpt.com/**', 'https://*.chatgpt.com/**'],
	// ChatGPT uses Bearer tokens harvested via /api/auth/session, not captured headers.
	// The interceptor config requires at least an empty array — we do the harvest manually.
	requiredHeaders: [],
	baseUrls: ['https://chatgpt.com'],
	loginUrl: 'https://chatgpt.com/auth/login',
};

/** Minimal concrete interceptor — ChatGPT session is harvested manually, not via header capture. */
class ChatGPTInterceptor extends GenericInterceptor {
	constructor() {
		super(config);
	}

	protected async handleRoute(route: Route): Promise<void> {
		try {
			await super.handleRoute(route);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes('Target page, context or browser has been closed')) return;
			try {
				await route.continue();
			} catch {}
		}
	}
}

export const plugin: DomainPlugin = {
	domainName: 'chatgpt',
	config,
	routes,
	createInterceptor: () => new ChatGPTInterceptor(),
};

// Named exports for direct use outside the plugin system
export { ChatGPTScriptInterceptor } from './fingerprint';
export { buildChatGPTFingerprintScript } from './fingerprint-script';
export { ChatGPTSessionManager } from './session';
export type {
	ChatGPTInterceptorMode,
	ChatGPTSessionStatus,
	ChatRequest,
	ChatStreamEvent,
} from './types';
