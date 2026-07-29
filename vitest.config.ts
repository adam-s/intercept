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
		],
	},
});
