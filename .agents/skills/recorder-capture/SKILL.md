---
name: recorder-capture
description: Last-resort escalation for a target that refuses automation on behaviour rather than fingerprint. Record the maintainer performing the flow once, then replay their real trajectories and timing. Use when both browser drivers have been tried and the target still blocks, or when the user says "record the flow", "it only works when I do it", "replay my session", "behavioural detection".
---

# Recorder capture — the last rung

Some targets do not read what the browser *is*. They read what it *does*: the
straight-line cursor, the uniform dwell, the keystroke cadence no hand produces.
No fingerprint change helps, because the fingerprint was never the problem.

This skill records the maintainer performing the flow once and replays their
actual motion. It is the **last** rung of the escalation ladder because it costs
a person's time and cannot run unattended.

## The ladder — do not start here

| Rung | Try this | Cost |
|---|---|---|
| 1 | `patchright` driver (default) | free |
| 2 | `camoufox` driver — different engine, different persona, OS-pinned profile | ~1.4 GB RAM, no CDP |
| 3 | **This skill** | a person's time, per flow |

**Gate: rungs 1 and 2 must have been tried and reported before this one opens.**
Run `npx tsx scripts/waf-probe.mjs` and read
[docs/BROWSER-DRIVERS.md](../../../docs/BROWSER-DRIVERS.md) first. If the
fingerprint score is non-zero, fix that instead — it is cheaper and it fixes
every target at once, not just this one.

If a target blocks with a **zero** fingerprint score under both drivers, the
signal is behavioural and this skill is the right answer.

## When to invoke

- Both drivers score zero automation tells and the target still blocks
- The maintainer says the flow "only works when I do it by hand"
- A flow depends on timing or gesture a synthetic curve cannot reproduce
- User says: "record the flow", "replay my session", "behavioural detection"

## What it records, and what it refuses to

**Recorded:** pointer trajectories including the coalesced sub-frame path,
button presses, scrolls, focus changes, and the timing of typing.

**Never recorded: the characters typed.** A `key` event carries its interval and
nothing else. The capture code never reads the key's identity, so a password, a
one-time code, or a card number cannot reach the log even transiently. This is
not a setting — a recording is a file that outlives the session that made it,
and `scripts/record-session.mjs` fails the run if any event carries content.

Replay therefore reproduces motion and cadence, never credentials. Anything
secret is supplied at replay time from the session manager.

## Procedure

**1. Confirm the ladder.** State which drivers were tried and what each scored.
A recording made because rung 1 was skipped is a person's time spent on a
problem a flag would have fixed.

**2. Get the maintainer's go-ahead.** Recording needs them at the keyboard, so
this is not a step you can take alone. Tell them the target, the flow, and
roughly how long it takes.

**3. Record.**

```bash
node scripts/record-session.mjs --mode=record \
  --url=<target> --out=data/recordings/<target>-<flow>.jsonl
```

The window opens headed. The maintainer performs the flow naturally and closes
the window to stop. Do not coach them into moving "like a human" — the whole
value is that they are one.

**4. Inspect before trusting it.**

```bash
node scripts/record-session.mjs --mode=inspect --in=data/recordings/<file>.jsonl
```

Two things to read:

- **`hasTrajectory`** — a recording with fewer than ten pointer moves holds no
  usable path. Replaying it produces exactly the straight-line motion this
  exists to avoid. Re-record instead of shipping it.
- **`leaks`** — must be zero. A non-zero count means content reached the log and
  the recording must be deleted, not repaired.

**5. Replay and verify.**

```bash
node scripts/record-session.mjs --mode=replay --in=data/recordings/<file>.jsonl
```

Replay reproduces the recording's own intervals. `--speed` scales the whole
timeline, and speeding it up is the fastest way to lose the property you
recorded — leave it at 1 unless you have measured that the target does not care.

**6. Record what you learned.** Which rung worked, and why, goes at the code
site or in the domain's config — not in a scratch note. If the target needed
this, the domain's config says so, so the next agent does not rediscover it.

## Bounds

The script caps a recording at 20,000 events and 15 minutes, writes only under
`data/recordings/`, and makes no model calls. Recordings are **gitignored**:
they are captured session material, and the Product invariant in AGENTS.md keeps
that out of git, out of copies handed to sub-agents, and out of anything
published.

## What this skill does not do

- **It does not solve challenges.** It reproduces motion. A target that presents
  an interactive challenge still needs a person, and that is a reported outcome,
  not a failure to work around.
- **It does not run unattended.** Recording needs a human by construction, and
  replay of a flow against a live third party is an outward-facing action —
  AGENTS.md keeps those behind a human checkpoint.
- **It does not generalize across targets.** A recording is of one flow on one
  site. Reusing one elsewhere reproduces motion that does not match the page,
  which is worse than synthetic motion that does.

## Prior art

`~/Projects/cairn` is the developed version of this idea: a concurrent event
model, stable element identity that survives a re-render, and reducers that turn
a raw event storm into a replay-grade record. `docs/RECORDER.md` there explains
the ordering model — capture-time stamps rather than flush-time, because
ordering by "when my handler ran" destroys the causal information a recorder
exists to capture. Read it before extending this skill; the hard parts are
solved there.
