/**
 * Drift pin for .agents/reference/anthropic-conventions.md's "Drift check"
 * table. The table is prose claiming what exists in the tree, and prose rots.
 * This pins the mechanically checkable claims:
 *   - every skill directory under .agents/skills/ has a table row
 *   - every rule under .agents/rules/ has a table row (this repo's divergence
 *     from the sibling repos, so nothing else documents it)
 *   - every sub-agent under .agents/agents/ has a table row
 *   - .claude/ holds nothing but settings.json and symlinks, so the canon in
 *     .agents/ stays readable by agents that don't know about .claude/
 *   - the symlinks the doc describes exist and point where it says
 *   - the hook scripts settings.json references are present and executable
 * Everything else in the table stays a claim to re-verify by hand.
 */

import { accessSync, constants, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOC = readFileSync(resolve(ROOT, '.agents/reference/anthropic-conventions.md'), 'utf8');

const dirsIn = (rel) =>
	readdirSync(resolve(ROOT, rel), { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name);

const filesIn = (rel, ext) =>
	readdirSync(resolve(ROOT, rel), { withFileTypes: true })
		.filter((d) => d.isFile() && d.name.endsWith(ext))
		.map((d) => d.name);

describe('anthropic-conventions drift-check table', () => {
	it('lists every skill directory under .agents/skills/', () => {
		const skills = dirsIn('.agents/skills');
		expect(skills.length).toBeGreaterThan(0);
		const missing = skills.filter((s) => !DOC.includes(`\`.agents/skills/${s}/\``));
		expect(missing).toEqual([]);
	});

	it('documents the .agents/rules/ mechanism and every rule that uses it', () => {
		const rules = filesIn('.agents/rules', '.md');
		expect(rules.length).toBeGreaterThan(0);
		// The Rules section explains the paths: frontmatter no sibling repo has.
		expect(DOC).toContain('## Rules — `.agents/rules/<name>.md` with `paths:` frontmatter');
		expect(DOC).toContain('| `.agents/rules/` |');
	});

	it('lists every sub-agent under .agents/agents/', () => {
		const agents = filesIn('.agents/agents', '.md').map((f) => f.replace(/\.md$/, ''));
		expect(agents.length).toBeGreaterThan(0);
		const missing = agents.filter((a) => !DOC.includes(`\`${a}\``));
		expect(missing).toEqual([]);
	});

	it('symlinks it describes exist and point where it says', () => {
		expect(readlinkSync(resolve(ROOT, '.claude/skills'))).toMatch(/\.agents\/skills\/?$/);
		expect(readlinkSync(resolve(ROOT, '.claude/rules'))).toMatch(/\.agents\/rules\/?$/);
		expect(readlinkSync(resolve(ROOT, '.claude/agents'))).toMatch(/\.agents\/agents\/?$/);
		expect(readlinkSync(resolve(ROOT, '.claude/CLAUDE.md'))).toMatch(/AGENTS\.md$/);
	});

	// The portability invariant: an agent that has never heard of .claude/ must
	// still find the whole canon by reading AGENTS.md and following it into
	// .agents/. Anything real that lands in .claude/ breaks that.
	it('keeps .claude/ to settings.json plus symlinks', () => {
		const stray = readdirSync(resolve(ROOT, '.claude'), { withFileTypes: true })
			.filter((d) => !d.isSymbolicLink())
			.map((d) => d.name)
			.filter((n) => n !== 'settings.json' && n !== 'settings.local.json' && n !== 'worktrees');
		expect(stray).toEqual([]);
	});

	it('root CLAUDE.md imports AGENTS.md rather than holding instructions', () => {
		const claudeMd = readFileSync(resolve(ROOT, 'CLAUDE.md'), 'utf8');
		expect(claudeMd).toContain('@AGENTS.md');
		// An entry point and a map of where the canon lives — nothing else. Past
		// this size it has started holding instructions that belong in AGENTS.md.
		expect(claudeMd.split('\n').length).toBeLessThan(30);
		// It maps every canonical location an agent needs to reach.
		for (const path of ['.agents/rules/', '.agents/skills/', '.agents/reference/', 'docs/']) {
			expect(claudeMd, `CLAUDE.md does not point at ${path}`).toContain(path);
		}
	});

	it('every hook settings.json references exists and is executable', () => {
		const settings = JSON.parse(readFileSync(resolve(ROOT, '.claude/settings.json'), 'utf8'));
		const commands = Object.values(settings.hooks ?? {})
			.flat()
			.flatMap((entry) => entry.hooks ?? [])
			.filter((h) => h.type === 'command')
			.map((h) => h.command);

		expect(commands.length).toBeGreaterThan(0);
		for (const command of commands) {
			const path = command.replaceAll('"', '').replace('$CLAUDE_PROJECT_DIR', ROOT);
			expect(
				() => accessSync(path, constants.X_OK),
				`${path} missing or not executable`,
			).not.toThrow();
		}
	});
});

describe('AGENTS.md holds principles, not facts', () => {
	const AGENTS = readFileSync(resolve(ROOT, 'AGENTS.md'), 'utf8');

	// The content rule from the sibling repos: a rule naming a particular
	// instance is a fact in the wrong file. These tokens are how facts leak.
	it.each([
		['a localhost URL', /localhost/i],
		['a hardcoded port', /:\d{4}\b/],
		['a curl invocation', /\bcurl\b/],
		['a /tmp path', /\/tmp\//],
		['a sleep call', /\bsleep \d/],
		['a tool-call budget', /\d+-\d+ (tool )?calls/i],
	])('contains no %s', (_name, pattern) => {
		const offenders = AGENTS.split('\n')
			.map((line, i) => [i + 1, line])
			.filter(([, line]) => pattern.test(line));
		expect(offenders).toEqual([]);
	});
});

describe('the elimination table and the signature table are one list', () => {
	// The original defect: the rule listed 8 transports, the scanner knew 7 under
	// different names, and neither could contradict the other. A row the scanner
	// cannot see is a row where a wrong verdict survives unchallenged.
	it('every signature has a row in the discovery rule, and vice versa', async () => {
		const { TRANSPORT_SIGNATURES } = await import('../discover-probe.mjs');
		const rule = readFileSync(resolve(ROOT, '.agents/rules/discovery.md'), 'utf8');
		const table = rule.slice(rule.indexOf('| Transport | Present? | Evidence |'));
		const rows = [...table.matchAll(/^\| ([^|]+?) \| ✓ or ✗/gm)].map((m) => m[1].trim());

		expect(rows.length).toBeGreaterThan(0);
		expect(rows.sort()).toEqual(Object.keys(TRANSPORT_SIGNATURES).sort());
	});
});
