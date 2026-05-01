/**
 * ChatGPT Session Manager
 *
 * Harvests and stores ChatGPT access tokens from an active browser session.
 *
 * ChatGPT uses NextAuth with a Bearer token (~24h lifetime) stored in the
 * session cookie. The token is not visible in normal traffic but IS accessible
 * from the page via fetch('/api/auth/session') — which returns:
 *   { accessToken: string, expires: string, user: { email, name, image } }
 *
 * HARVEST FLOW
 * ─────────────
 * 1. Browser navigates to chatgpt.com (logged-in profile)
 * 2. Call harvestSession(page) — runs fetch('/api/auth/session') in page context
 * 3. Extracts accessToken + user info, stores in GenericSessionManager
 * 4. Routes use getAccessToken() to get a fresh token for API calls
 *
 * TOKEN REFRESH
 * ─────────────
 * Tokens expire in ~24h. needsHarvest() returns true when the token is older
 * than 20h so the caller can re-harvest before expiry.
 */

import { GenericSessionManager } from '@interceptor/browser/shared/session-manager';
import type { Page } from 'patchright';
import type { ChatGPTSessionStatus } from './types';

const PROFILE_NAME = 'chatgpt';
const TOKEN_MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours

interface HarvestedAuth {
	accessToken: string;
	email?: string;
	harvestedAt: number;
}

interface AuthSessionResponse {
	accessToken?: string;
	expires?: string;
	user?: {
		email?: string;
		name?: string;
		image?: string;
	};
}

export class ChatGPTSessionManager {
	private static instance: ChatGPTSessionManager;
	private mgr = GenericSessionManager.getInstance(PROFILE_NAME);
	private auth: HarvestedAuth | null = null;

	private constructor() {}

	static getInstance(): ChatGPTSessionManager {
		if (!ChatGPTSessionManager.instance) {
			ChatGPTSessionManager.instance = new ChatGPTSessionManager();
		}
		return ChatGPTSessionManager.instance;
	}

	/**
	 * Harvest access token from an active chatgpt.com browser page.
	 *
	 * The page must already be on chatgpt.com and logged in. Runs
	 * fetch('/api/auth/session') inside the page context so cookies are
	 * forwarded automatically.
	 */
	async harvestSession(page: Page): Promise<{ ok: boolean; email?: string; error?: string }> {
		try {
			const result = await page.evaluate(async () => {
				const res = await fetch('/api/auth/session', {
					credentials: 'include',
					headers: { Accept: 'application/json' },
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return (await res.json()) as AuthSessionResponse;
			});

			if (!result.accessToken) {
				return { ok: false, error: 'No accessToken in session response — not logged in?' };
			}

			this.auth = {
				accessToken: result.accessToken,
				email: result.user?.email,
				harvestedAt: Date.now(),
			};

			// Store in GenericSessionManager so other parts of the app can see status
			this.mgr.setHeaders(PROFILE_NAME, {
				Authorization: `Bearer ${result.accessToken}`,
			});

			console.log('[ChatGPTSession] Harvested token for', result.user?.email ?? 'unknown');
			return { ok: true, email: result.user?.email };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			console.error('[ChatGPTSession] Harvest failed:', error);
			return { ok: false, error };
		}
	}

	getAccessToken(): string | null {
		return this.auth?.accessToken ?? null;
	}

	needsHarvest(): boolean {
		if (!this.auth) return true;
		return Date.now() - this.auth.harvestedAt > TOKEN_MAX_AGE_MS;
	}

	getStatus(): ChatGPTSessionStatus {
		const hasToken = !!this.auth?.accessToken;
		return {
			connected: hasToken,
			email: this.auth?.email,
			tokenAgeMs: this.auth ? Date.now() - this.auth.harvestedAt : undefined,
			needsRefresh: this.needsHarvest(),
		};
	}
}
