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
      "detectableBy": "observation", // or "scan" — see below
      "endpoints": ["wss://…"],
      "encoding": "optional — what rides inside, if it is not obvious",
      "note": "what makes it easy to miss"
    }
  ]
}
```

`asOf` is load-bearing. A key is a record of what a source said on a date, not a
permanent fact — a site that migrates makes a stale key report false misses,
which is worse than having no key at all.

##  — and why encoding is not a transport

A manifest is built from the primitives a page reached for, so it can report
that a socket opened and never that the frames inside it were encrypted. Rows
that are verdicts about a payload's *shape* — embedded data, an encoded body,
markup-over-the-wire, gRPC framing — are : real, but answerable only
from the source, so the scorer lists them separately instead of counting them as
misses. Everything else is .

Getting this wrong makes the score lie in one of two directions, so a repo test
checks each declaration against what the classifier can actually emit.

The same distinction settles where a transport belongs. Twitch's hermes socket
carries an encrypted envelope and its chat socket carries IRC text; both are one
row, , with the encoding recorded as a property. Filing an encoding
as its own expected transport made a socket we did observe score as a miss.

