# Phase 1: Understand the Application

**Do this before writing any Patchright script.** Read the source code to build a mental model. Screenshots without understanding lead to surface-level fixes that miss structural problems.

## Start from the URL, not the file tree

1. **Find the route file** for the URL you'll visit: `Grep "dashboard" --glob "**/page.tsx"`
2. **Read the page component.** What does it render? Follow imports one level deep.
3. **Read each significant child component.** What data does it consume? What interactions does it expose? Does it subscribe to external state (SSE, WebSocket, polling)?
4. **Trace data dependencies one more level** when they involve network. If a component calls `fetch("/api/something")`, find that API route and read it.

The goal: **URL → page → components → data sources → backend**. You don't need every file — just enough to know what each visible element represents.

## Form expectations before screenshotting

Based on the code you just read, predict:
- What elements should be visible on initial load?
- What should happen when each button/form is used?
- How long until results appear? (instant for local state, ~1s for API, variable for SSE)
- At wide viewports, should content be constrained or fill the screen?

These expectations become your verification criteria. When a screenshot doesn't match, you already know where in the stack to look.
