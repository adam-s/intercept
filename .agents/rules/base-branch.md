---
description: main is the only permanent branch — test branches are disposable
---

# Main Is the Only Branch

**`main` is the product. Test branches are disposable.**

| Lives on `main` (permanent) | Lives on test branches (ephemeral) |
|---|---|
| `AGENTS.md`, `.agents/`, `prompts/` | `domains/<name>/` — domain plugins |
| Framework code in `packages/` | Domain-specific routes, UI pages |
| Shared utilities in `apps/api/src/` | `data/browser-profiles/<domain>/` |
| Bounded scripts in `scripts/` | Domain route-spec baselines |

**The invariant:** Delete every test branch — nothing of lasting value is lost. Everything that matters is on `main`.

**Each piece of knowledge has exactly one home.** A guard on a specific
implementation is a comment at that implementation. A generalized principle is
AGENTS.md. A path-scoped procedure is a rule here. A bound that must be enforced
is a script docblock. Skills teach HOW and stay domain-agnostic; prompts say
WHAT and are domain-specific. This is the same rule AGENTS.md states as
"principles only, never facts", read from the other direction.

## Framework fixes found on a test branch

A fix belongs in the file it fixes — see AGENTS.md §"Durable knowledge". There
is no fix queue and no memory file: a fix parked in a scratch note for a later
branch is a fix that gets lost.

Framework code, instructions, and skills live on `main`. When work on a test
branch turns up a fix to one of them, apply it to that file on `main` — as its
own commit, separate from the domain work — then continue. The test branch
stays disposable, which is the invariant above.
