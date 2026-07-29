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
};

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
			if (wire === 0) out[name] = Number(varint());
			else if (wire === 1) {
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
	return out;
}
