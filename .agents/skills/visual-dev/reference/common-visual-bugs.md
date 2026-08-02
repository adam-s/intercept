# Common Visual Bugs Checklist

Check for these during every screenshot iteration. Add new bugs as they're discovered.

## Layout Bugs

- [ ] Content overflows its container (horizontal scroll on page)
- [ ] Text truncated without ellipsis — cut off mid-word
- [ ] Cards/panels have inconsistent heights in a grid
- [ ] Empty state shows blank area instead of a message
- [ ] Loading state missing — content pops in without skeleton/spinner
- [ ] List inside card grows unbounded — always cap with `max-h-[Npx] overflow-y-auto`
- [ ] Sidebar overlaps main content on narrow viewports
- [ ] Footer overlaps content or floats in middle of page

## Typography Bugs

- [ ] Text too small to read (below 12px)
- [ ] Text color has poor contrast against background
- [ ] Heading hierarchy broken (h3 looks bigger than h2)
- [ ] Long text (URLs, IDs, JSON) breaks layout instead of wrapping/truncating
- [ ] Monospace code blocks don't have horizontal scroll

## Color & Theme Bugs

- [ ] Hardcoded light colors that flash white on dark theme
- [ ] Border colors that disappear on dark backgrounds
- [ ] Status colors not semantically consistent (green = success, red = error)
- [ ] Hover states missing or invisible

## Data Display Bugs

- [ ] Numbers not formatted (1234567 instead of 1,234,567)
- [ ] Currency missing symbol ($, €)
- [ ] Dates in raw ISO format instead of human-readable
- [ ] JSON dumped as raw string instead of formatted
- [ ] Empty arrays show "[]" instead of "No results"
- [ ] Null values display as "null" text

## Interaction Bugs

- [ ] Button looks clickable but does nothing
- [ ] Disabled button not visually distinct
- [ ] Input field has no focus ring
- [ ] Enter key doesn't submit the search form
- [ ] No feedback after clicking (no loading indicator)

## Error State Bugs

- [ ] Error message is generic ("Something went wrong") with no actionable guidance
- [ ] Error breaks the entire page instead of being contained
- [ ] Network error shows stack trace instead of user-friendly message
- [ ] 503 from proxy doesn't explain that browser needs to be connected
- [ ] Raw HTTP status codes shown to users instead of actionable messages

## Multi-Domain Specific

- [ ] One domain failing causes all domains to fail (use Promise.allSettled)
- [ ] Domain cards have inconsistent structure when data shapes differ
- [ ] Missing domain name label — can't tell which site data came from
- [ ] No visual indicator of which domain has the best price/value
- [ ] Matched vs single-source rows not visually distinct in comparison tables
- [ ] No per-platform loading/error feedback — user can't tell which source is working
