/**
 * Portability check for functions that are shipped into a page.
 *
 * A function written here and executed *there* crosses a boundary that nothing
 * in the type system marks. It travels as source: the driver calls `toString()`
 * and the page evaluates the text. Module scope does not travel with it, and
 * neither does anything the build injected — so a body that references a helper
 * defined alongside it compiles, type-checks, lints, and then throws
 * `ReferenceError` in the page on every single call.
 *
 * The build injects those helpers without being asked. Under esbuild's
 * `--keep-names`, which tsx turns on by default and several bundlers do too,
 * every function expression it can name is emitted wrapped as `__name(fn, "id")`
 * — including nested ones, whose wrapper lands inside the body being shipped
 * while `__name` itself stays behind. Class fields do the same through
 * `__publicField`.
 *
 * The failure is silent in the direction that matters. Nothing throws on our
 * side; the page throws, the caller catches, and the run reports the work it
 * managed elsewhere. Measured once in the instrument, where it cost the entire
 * capture, and once in the interaction sweep, where a one-line arrow helper
 * cost six of seven provocations and left a report that read as a quiet page.
 *
 * Two defences, and they are not alternatives. Source that is *installed* as
 * text can carry a prologue defining the helpers as identities — that is what
 * the instrument does. Source *passed as a function reference*, which the page
 * receives verbatim, cannot, so it must contain no nested function at all. This
 * module is the gate for the second kind: a test asserts each such function is
 * portable, so the next edit that reaches for a tidy inner helper fails in CI
 * rather than in a page nobody is watching.
 *
 * @module browser/driver/page-function
 */

/**
 * A caution about how this is checked, because the obvious way does not work.
 *
 * The tempting gate reads `fn.toString()` and looks for the helpers. It passes
 * unconditionally: the helper is injected by whichever transpiler built the
 * code, and a unit-test runner uses its own. Under Vitest nothing is injected,
 * so the source is clean and the check is green — including on the exact edit
 * that caused the outage, which was verified by reintroducing it and watching
 * the suite stay green. A check that cannot go red is indistinguishable from a
 * check that passes, which is the whole reason it must not be the gate.
 *
 * So the gate reads the file on disk and looks for the *cause* rather than the
 * symptom: a nested function inside a body that ships to the page. That fact is
 * transpiler-independent, present in the text we wrote, and true regardless of
 * who builds it.
 */

/** Helpers a build is known to inject. Each is invisible in the source we wrote. */
export const BUILD_HELPERS = ['__name', '__publicField', '__defProp', '__decorateClass'] as const;

/** Comments and literals, removed so a token inside one is not read as code. */
function stripNonCode(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.replace(/\/\/[^\n]*/g, ' ')
		.replace(/`(?:\\.|[^`\\])*`/g, '``')
		.replace(/'(?:\\.|[^'\\])*'/g, "''")
		.replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/**
 * The body of a named function declaration, by brace matching.
 *
 * Returns null when the name is absent, which the caller must treat as a
 * failure rather than as an empty body — a renamed function would otherwise
 * silently stop being checked, and pass.
 */
export function extractFunctionBody(source: string, name: string): string | null {
	const code = stripNonCode(source);
	const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(code);
	if (!decl) return null;

	// A brace group after the parameters may be an inline return type rather than
	// the body — `function f(x): { a: string } { … }` has two, and taking the
	// first silently checks the type annotation instead of the code. Whatever is
	// followed by another brace group was a type, so keep walking.
	let cursor = decl.index + decl[0].length;
	for (let guard = 0; guard < 8; guard++) {
		const open = code.indexOf('{', cursor);
		if (open === -1) return null;
		let depth = 0;
		let close = -1;
		for (let i = open; i < code.length; i++) {
			if (code[i] === '{') depth++;
			else if (code[i] === '}' && --depth === 0) {
				close = i;
				break;
			}
		}
		if (close === -1) return null;
		const next = code.slice(close + 1).match(/^\s*(.)/)?.[1];
		if (next === '{') {
			cursor = close + 1;
			continue;
		}
		return code.slice(open + 1, close);
	}
	return null;
}

/**
 * Nested function forms found in a body. Each is a helper the build will wrap.
 *
 * Strips comments and literals first. Without that, prose describing the hazard
 * trips the check that enforces it — and the fix a reader reaches for is to
 * delete the explanation.
 */
export function findNestedFunctions(body: string): string[] {
	const code = stripNonCode(body);
	const found: string[] = [];
	if (/=>/.test(code)) found.push('arrow function');
	if (/\bfunction\b/.test(code)) found.push('function expression');
	if (/\bclass\b/.test(code)) found.push('class');
	return found;
}

/**
 * Fail when a page-bound function would not survive the trip.
 *
 * Reads the file rather than the function, for the reason given at the top of
 * this module: the runtime form of a function is decided by whichever
 * transpiler built the test, so a `toString()` check is green under Vitest even
 * when the shipped build is broken.
 */
export function assertPageFunctionIsPortable(source: string, name: string): void {
	const body = extractFunctionBody(source, name);
	if (body === null) {
		throw new Error(
			`${name} was not found in the source given. A page-bound function that is renamed or moved ` +
				`stops being checked, and an unchecked function reads exactly like a passing one.`,
		);
	}
	const nested = findNestedFunctions(body);
	if (nested.length) {
		throw new Error(
			`${name} contains a nested ${nested.join(' and ')}, which the build emits wrapped in a helper ` +
				`(${BUILD_HELPERS.join(', ')}) that is not defined in the page. Every call will throw ` +
				`ReferenceError and be swallowed as an uninspectable element. Inline it — see ` +
				`browser/driver/page-function.`,
		);
	}
}
