import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		projects: [
			'packages/shared',
			'packages/browser',
			'apps/api',
			'apps/web',
			{
				// Repo-level checks that belong to no package: the conventions drift
				// pin, and the script-contract pin. `turbo test` only reaches
				// per-package suites, so CI runs this project explicitly via
				// `pnpm test:repo`.
				test: {
					name: 'repo',
					include: ['scripts/__tests__/**/*.test.mjs'],
				},
			},
			{
				// Domain plugins are ephemeral, but a decoder pinned to captured bytes
				// is not: without a project that reaches it, the file is a claim rather
				// than a check, and a wrong decode ships looking exactly like a right
				// one. Glob-based, so a domain that carries no test contributes nothing
				// and a new one is picked up without editing this list.
				test: {
					name: 'domains',
					include: ['domains/*/src/**/*.test.ts'],
				},
			},
		],
	},
});
