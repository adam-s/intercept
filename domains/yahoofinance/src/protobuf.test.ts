/**
 * Frames captured from `wss://streamer.finance.yahoo.com/?version=2` on
 * 2026-07-29, kept verbatim. They are the only record of what the wire actually
 * carried, so they pin the two things a reader of this decoder cannot otherwise
 * check: which varint fields are zigzag-encoded, and that a value too large for
 * a double is reported exactly instead of rounded.
 *
 * Break either and this goes red. Decode field 3 as plain and the timestamp
 * lands in 2083; decode field 33 as zigzag and BTC's market cap halves.
 */

import { describe, expect, it } from 'vitest';
import { decodePricing } from './protobuf';

const FRAME_BTC =
	'CgdCVEMtVVNEFfNvd0cY4KfB+/VnIgNVU0QqA0NDQzApOAFFpPBbv0iAoK7IzgFVaGx8R107IndHZYA7CcR9fW15R7ABgKCuyM4B2AEE4AGAoK7IzgHoAYCgrsjOAfIBA0JUQ4ECAAAAgCwic0GJAgAAQ+AAeXJC';
const FRAME_AAPL = 'CgRBQVBMFQDAqUMYgMfB+/VnKgNOTVMwCDgCRXZTxj5lAK6nP9gBBA==';

const decode = (b64: string) => decodePricing(Buffer.from(b64, 'base64'));

describe('decodePricing', () => {
	it('names the fields it recognises and reports the rest by number', () => {
		const f = decode(FRAME_AAPL);
		expect(f.id).toBe('AAPL');
		expect(f.exchange).toBe('NMS');
		expect(f.price).toBeCloseTo(339.5, 2);
		// An unnamed field still arrived, so it is still reported.
		expect(f).toHaveProperty('field27');
	});

	it('decodes field 3 as sint64, so the timestamp is the capture time', () => {
		const f = decode(FRAME_BTC);
		expect(f.time).toBe(1785359510000);
		expect(f.timeIso).toBe('2026-07-29T21:11:50.000Z');
		// The plain reading, which is the defect this pins.
		expect(f.time).not.toBe(3570719020000);
	});

	it('decodes field 9 as sint64, halving the doubled volume', () => {
		expect(decode(FRAME_BTC).dayVolume).toBe(27724728320);
	});

	it('leaves fields 32 and 33 plain, because zigzag makes them wrong', () => {
		const f = decode(FRAME_BTC);
		// ~19.9M BTC in circulation, not ~10M.
		expect(f.circulatingSupply).toBe(20062920);
		// price × supply ≈ this. Zigzag would report half.
		expect(f.marketCap).toBe(1269432190000);
		expect(Number(f.price) * Number(f.circulatingSupply) - Number(f.marketCap)).toBeLessThan(
			Number(f.marketCap) * 0.05,
		);
	});

	it('never throws on a truncated frame, and keeps what decoded', () => {
		const full = Buffer.from(FRAME_BTC, 'base64');
		const cut = decodePricing(full.subarray(0, 12));
		expect(cut.id).toBe('BTC-USD');
	});

	it('reports a value beyond safe-integer range exactly, as a string', () => {
		// field 33 (marketCap, plain varint) holding 2^60 — a value a double would
		// round, and a real magnitude for a market cap in a minor currency.
		//
		// The tag is two bytes and that matters: `(33 << 3) | 0` is 264, so writing
		// it as one byte truncates to 8 and encodes field 1 instead. The first
		// version of this test did exactly that, which is why it asserted against
		// `undefined` — the buffer never contained the field it was about.
		const buf = Buffer.from([
			0x88,
			0x02, // tag: field 33, wire type 0
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x80,
			0x10, // varint 2^60
		]);
		expect(decodePricing(buf).marketCap).toBe('1152921504606846976');
	});
});
