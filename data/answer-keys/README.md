# Answer keys — grader-held, never briefing

Each file records the transport surface a target is publicly known to have,
drawn from published reverse-engineering work rather than from any run of ours.
They exist so a recall number can be *scored* instead of guessed: captured
traffic is a floor, and a floor cannot say what a run missed.

**Nothing that performs discovery may read these.** Naming the expected finding
in front of the thing being measured destroys the measurement — the whole value
of a discovery run is that it was independent. See AGENTS.md, "Keep the answer
out of the exam paper." A repo test asserts that no instruction, rule, prompt,
or agent definition references this directory.

Scoring happens afterwards, by the maintainer, with
`node scripts/score-recall.mjs --target=<name> --run=<derived-table.json>`.

## Shape

```jsonc
{
  "target": "example.com",
  "asOf": "2026-07-29",              // keys go stale; re-verify before trusting
  "sources": ["https://…"],          // where each row came from
  "transports": [
    {
      "transport": "WebSocket",      // an elimination-table row name
      "endpoints": ["wss://…"],
      "note": "what makes it easy to miss"
    }
  ]
}
```

`asOf` is load-bearing. A key is a record of what a source said on a date, not a
permanent fact — a site that migrates makes a stale key report false misses,
which is worse than having no key at all.
