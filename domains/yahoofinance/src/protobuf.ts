/**
 * Enough protobuf to read a price frame.
 *
 * The stream's frames are a JSON envelope whose `message` is base64-wrapped
 * protobuf. Reading them as text yields noise, which is why a socket carrying
 * the most valuable data on the site reads as a socket carrying nothing. There
 * is no published schema, so this decodes by wire type and names the fields it
 * recognises — an unknown field is reported by number rather than dropped,
 * because a field we cannot name is still a field that arrived.
 *
 * **Some varint fields are zigzag-encoded and some are not, and nothing in the
 * wire format says which.** A protobuf varint is `int64` unless the schema
 * declared it `sint64`, and `sint64` values arrive doubled-and-folded. Decoding
 * every varint as plain gives a timestamp in 2083 that still parses as a date,
 * and a volume exactly twice the real one — both plausible enough to ship. So
 * the zigzag set is derived from observed frames against known-true values, and
 * the derivation is recorded here so it can be re-checked rather than trusted:
 *
 * | Field | Raw | Zigzag | Which is right |
 * |---|---|---|---|
 * | 3 `time` | 3570719020000 (year 2083) | 1785359510000 | zigzag — matched the wall clock at capture |
 * | 9 `dayVolume` | 55449456640 | 27724728320 | zigzag — BTC-USD 24h volume was ~$27.7B |
 * | 32 `circulatingSupply` | 20062920 | 10031460 | raw — BTC supply is ~19.9M coins, not ~10M |
 * | 33 `marketCap` | 1269432190000 | 634716095000 | raw — $63,344 × 19.9M coins ≈ $1.26T |
 *
 * Fields 32 and 33 are load-bearing to that table: they prove the encoding is
 * per-field rather than uniform, so "decode everything as zigzag" is as wrong as
 * "decode nothing as zigzag". Measured 2026-07-29 against live BTC-USD, ETH-USD
 * and AAPL frames; the pinning test carries those frames verbatim, so a schema
 * change shows up as a red test rather than as quietly wrong numbers.
 *
 * @module domain-yahoofinance/protobuf
 */

/** Field numbers, as far as they are known from observed frames. */
export const PRICING_FIELDS: Record<number, string> = {
	1: 'id',
	2: 'price',
	3: 'time',
	4: 'currency',
	5: 'exchange',
	6: 'quoteType',
	7: 'marketHours',
	8: 'changePercent',
	9: 'dayVolume',
	10: 'dayHigh',
	11: 'dayLow',
	12: 'change',
	13: 'shortName',
	15: 'openPrice',
	16: 'previousClose',
	30: 'baseCurrency',
	32: 'circulatingSupply',
	33: 'marketCap',
};

/**
 * Varint fields observed to be `sint64`. See the module docblock for the
 * evidence behind each; a field absent here is decoded as plain `int64`, which
 * is protobuf's default and the safer assumption for a field we cannot name.
 */
export const ZIGZAG_FIELDS = new Set([3, 9, 22, 28, 29]);

/** Undo protobuf zigzag. */
function unzigzag(n: bigint): bigint {
	return (n >> 1n) ^ -(n & 1n);
}

/**
 * A BigInt narrowed to `number` only when that is lossless.
 *
 * Volumes and market caps exceed `Number.MAX_SAFE_INTEGER` on the busiest
 * symbols, and silently rounding one is the kind of numeric defect that never
 * looks like a defect. Anything too large is reported as a decimal string, so
 * the caller sees an exact value and chooses how to parse it.
 */
function narrow(n: bigint): number | string {
	return n >= -9007199254740991n && n <= 9007199254740991n ? Number(n) : n.toString();
}

/** Decode a flat protobuf message of scalars and strings. Never throws. */
export function decodePricing(buf: Buffer): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let i = 0;
	const varint = (): bigint => {
		let result = 0n;
		let shift = 0n;
		while (i < buf.length) {
			const b = buf[i++];
			result |= BigInt(b & 0x7f) << shift;
			if (!(b & 0x80)) break;
			shift += 7n;
		}
		return result;
	};

	try {
		while (i < buf.length) {
			const key = Number(varint());
			const field = key >> 3;
			const wire = key & 7;
			const name = PRICING_FIELDS[field] ?? `field${field}`;
			if (wire === 0) {
				const raw = varint();
				out[name] = narrow(ZIGZAG_FIELDS.has(field) ? unzigzag(raw) : raw);
			} else if (wire === 1) {
				out[name] = buf.readDoubleLE(i);
				i += 8;
			} else if (wire === 2) {
				const len = Number(varint());
				const slice = buf.subarray(i, i + len);
				i += len;
				const text = slice.toString('utf8');
				// A length-delimited field is a string or a nested message; printable
				// bytes are almost certainly the former.
				out[name] = /^[\x20-\x7e]*$/.test(text) ? text : `<${len} bytes>`;
			} else if (wire === 5) {
				out[name] = buf.readFloatLE(i);
				i += 4;
			} else break; // an unknown wire type means the rest cannot be trusted
		}
	} catch {
		// A truncated frame yields what was read before it ran out, which is more
		// useful than discarding the fields that did decode.
	}
	// `time` is the field a consumer is most likely to misread, so it is handed
	// over already interpreted — epoch milliseconds decoded wrongly still look
	// like a date, and an ISO string makes the error visible at a glance.
	if (typeof out.time === 'number') out.timeIso = new Date(out.time).toISOString();
	return out;
}
