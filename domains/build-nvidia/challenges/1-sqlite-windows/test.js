// Test suite for SQLite window functions challenge.
// Run: node test.js
// All 5 tests must pass.

import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

let passed = 0;
let failed = 0;

function assert(condition, name, detail) {
	if (condition) {
		console.log(`PASS: ${name}`);
		passed++;
	} else {
		console.log(`FAIL: ${name}${detail ? ' — ' + detail : ''}`);
		failed++;
	}
}

// Load the solution
if (!existsSync('queries.js')) {
	console.log('FAIL: queries.js not found');
	process.exit(1);
}

// Run queries.js and parse JSON output
let results;
try {
	const output = execSync('node queries.js', { encoding: 'utf8', timeout: 10000 });
	results = JSON.parse(output);
} catch (e) {
	console.log('FAIL: queries.js did not produce valid JSON output');
	console.log(e.message);
	process.exit(1);
}

// Test 1: running_total
{
	const rt = results.running_total;
	assert(
		rt && rt.length === 100,
		'running_total has 100 rows',
		rt ? `got ${rt.length}` : 'missing',
	);
	if (rt && rt.length > 0) {
		const c1 = rt.filter((r) => r.customer_id === 1);
		const firstRT = c1[0]?.running_total;
		const lastRT = c1[c1.length - 1]?.running_total;
		assert(Math.abs(firstRT - 120) < 0.01, 'running_total first order = 120', `got ${firstRT}`);
		const expectedTotal = 1523; // sum of customer 1's 10 orders
		assert(
			Math.abs(lastRT - expectedTotal) < 0.01,
			'running_total cumulates correctly',
			`last=${lastRT}, expected=${expectedTotal}`,
		);
	}
}

// Test 2: rank_customers
{
	const rk = results.rank_customers;
	assert(rk && rk.length === 10, 'rank_customers has 10 rows', rk ? `got ${rk.length}` : 'missing');
	if (rk && rk.length > 0) {
		const rank1 = rk.find((r) => r.rank === 1);
		const rank2 = rk.find((r) => r.rank === 2);
		assert(
			rank1 && rank2 && rank1.total_spend >= rank2.total_spend,
			'rank 1 has highest spend',
			`rank1=${rank1?.total_spend}, rank2=${rank2?.total_spend}`,
		);
	}
}

// Test 3: prev_order (LAG)
{
	const po = results.prev_order;
	assert(po && po.length === 100, 'prev_order has 100 rows', po ? `got ${po.length}` : 'missing');
	if (po && po.length > 0) {
		const c1 = po.filter((r) => r.customer_id === 1);
		assert(
			c1[0]?.prev_amount === null || c1[0]?.prev_amount === undefined,
			'first order has null prev_amount',
			`got ${c1[0]?.prev_amount}`,
		);
		if (c1.length >= 2) {
			assert(
				Math.abs((c1[1]?.prev_amount || 0) - c1[0]?.amount) < 0.01,
				'prev_amount matches previous order',
				`prev=${c1[1]?.prev_amount}, expected=${c1[0]?.amount}`,
			);
		}
	}
}

// Test 4: moving_avg (3-order window)
{
	const ma = results.moving_avg;
	assert(ma && ma.length === 100, 'moving_avg has 100 rows', ma ? `got ${ma.length}` : 'missing');
	if (ma && ma.length > 0) {
		const c1 = ma.filter((r) => r.customer_id === 1);
		if (c1.length >= 3) {
			const expected = Math.round(((120 + 85.5 + 200) / 3) * 100) / 100; // 135.17
			assert(
				Math.abs(c1[2]?.moving_avg - expected) < 0.02,
				'moving_avg 3-order window correct',
				`got=${c1[2]?.moving_avg}, expected=${expected}`,
			);
		}
	}
}

// Test 5: pct_of_total
{
	const pt = results.pct_of_total;
	assert(pt && pt.length === 100, 'pct_of_total has 100 rows', pt ? `got ${pt.length}` : 'missing');
	if (pt && pt.length > 0) {
		const c1 = pt.filter((r) => r.customer_id === 1);
		const sum = c1.reduce((s, r) => s + (r.pct_of_total || 0), 0);
		assert(Math.abs(sum - 100) < 1, 'pct_of_total sums to ~100%', `got ${sum.toFixed(2)}%`);
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
