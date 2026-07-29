# Decoding Encoded API Responses

When a captured API response contains values that don't match what's rendered in the DOM — wrong prices, cryptic IDs instead of names, numbers in unexpected units — the site's JavaScript is decoding or transforming the raw response before display. The DOM is always ground truth. Trace backwards from the rendered output through the minified JS to find the decoder.

## Why this works

**String literals survive minification.** Variable names get mangled to `k`, `n`, `o` but string constants — attribute values, JSON property names, error messages, URL patterns — are preserved because they're runtime values. These are your anchors into the minified code.

## The technique

**Step 1 — Anchor from the DOM.** Find the element displaying the value. Note a stable identifier: `data-testid`, `data-bdd`, `aria-label`, or a unique string in the element's attributes. Avoid class names (they change with CSS-in-JS).

**Step 2 — Fetch the JS bundle.** The page's `<script src="...">` tags point to the bundles. Download the main bundle. Search for your anchor string.

**Step 3 — Read outward from the match.** The anchor sits inside a render function. The displayed value is a nearby variable used as `children:` or `textContent`. That variable was assigned from a prop or data object earlier in the same function.

**Step 4 — Follow property accesses.** Property names on objects survive minification: `n.basePrice` stays as `.basePrice` even when `n` is meaningless. The dotted property path tells you the exact shape of the decoded object.

**Step 5 — Find the transform between raw API and rendered value.** Look for arithmetic (`n / 100`), lookups (`e._rates[t.rateKey]`), or formatting (`"$" + n.toFixed(2)`). This is the decoder.

## Example: encoded prices

API returns `{ "rateKey": "MK4XNRQ" }` and `{ "_rates": { "MK4XNRQ": { "cents": 8999 } } }`. DOM shows `$89.99`.

Search JS bundle for `"board-price"`:
```javascript
(0,x.jsx)(eB,{"data-testid":"board-price",children:"$"+(n._rates[t.rateKey].cents/100).toFixed(2)})
```

Decoder: indirect key lookup → cents ÷ 100 → format as dollars.

## Common encoding patterns

| Pattern | Signal | Decode |
|---------|--------|--------|
| **Indirect reference** | Items contain encoded IDs; sibling `_embedded`/`_pricing` block has matching keys | Map ID to referenced object |
| **Unit mismatch** | Raw number 100x or 1000x displayed value | Divide by scale factor |
| **Currency localization** | Price prefix is `S/.`, `€`, `£` instead of `$` | Strip prefix, detect currency, convert |
| **Nested path** | Value at `item.offer.pricing.total.amount` not `item.price` | Follow dotted path in JS bundle |
| **Computed values** | Displayed value is sum/product of fields | Look for arithmetic in render function |

## When to use this

- `curl` returns data but numbers don't match page
- Fields contain encoded strings instead of readable values
- Prices off by factor of 100 or 1000
- API has `_embedded`, `_refs`, or `_linked` block

## When NOT to use this

- API returns clean, matching values — just use them
- Site has public API documentation — read the docs
