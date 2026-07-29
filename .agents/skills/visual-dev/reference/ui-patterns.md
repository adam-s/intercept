# UI Component Reference & Patterns

Full shadcn/ui catalog: **https://ui.shadcn.com/docs/components** — install with `cd apps/web && npx shadcn@latest add <name>`.

## Available Components

| Component | Status | Pattern | When to Use |
| --- | --- | --- | --- |
| **Sheet** | Installed | Side panel, slides from edge | Detail view for a selected row |
| **Tooltip** | Installed | Hover reveal, 0ms delay | Extra data on truncated values |
| **Dropdown Menu** | Installed | Context menu | Per-row actions |
| **Tabs** | Install needed | In-place content switching | Switch views without navigation |
| **Collapsible** | Install needed | Expand/collapse section | Show/hide metadata |
| **Popover** | Install needed | Anchored floating panel | Filters, quick stats |
| **Dialog** | Install needed | Centered modal | Confirmations |
| **Command** | Install needed | Cmd+K palette | Quick actions, search |

## Choosing the Right Component

- **Level 1 — Glanceable:** Tooltip, Badge, color coding
- **Level 2 — One click:** Collapsible, Dropdown Menu, Popover
- **Level 3 — Focused context:** Sheet, Dialog, Tabs
- **Level 4 — Power user:** Command palette, Resizable panels

Start at Level 1. Add higher levels when information won't fit.

## Visual Transition Patterns

| Pattern | Use Case |
| --- | --- |
| **Slide-in** | List → detail: Sheet from edge |
| **Fade + scale** | Centered overlays |
| **Collapse push** | Expanding sections |
| **Hover preview → click commit** | HoverCard → Sheet |
| **Border accent carry** | Row color matches detail panel |
| **Skeleton → content** | Loading preserves dimensions |

### Anti-patterns
- **Jump cuts** — Add at minimum 150ms fade
- **Conflicting directions** — Match entry/exit directions
- **Delayed skeleton** — Show immediately or don't use one
- **Color disconnects** — Carry color intent through all views

## Dark Mode

Think about what each element IS, not just its color:

- **Neutral surface?** Use `bg-background`, `bg-muted`, `border-border`
- **Accent/highlight?** Use dark-900/950 range with opacity: `bg-blue-950/30 border-blue-500/20`
- **Interactive feedback?** `hover:bg-muted`, `active:bg-muted/80`
- **Text hierarchy:** `text-foreground` (primary), `text-muted-foreground` (secondary), `text-blue-400` (accent)

| Light-mode (broken on dark) | Semantic replacement |
| --- | --- |
| `bg-white`, `bg-gray-50` | `bg-background` or `bg-muted` |
| `bg-blue-50`, `bg-green-50` | `bg-blue-950/30`, `bg-green-950/30` |
| `border-gray-200` | `border-border` |
| `text-gray-500` | `text-muted-foreground` |
| `hover:bg-gray-50` | `hover:bg-muted` |
