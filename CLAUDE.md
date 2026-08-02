@AGENTS.md

This file is the Claude Code entry point only. Everything it points at is
agent-agnostic and lives under [.agents/](.agents/), so Codex and other coding
agents read the same canon:

| Path | Holds |
|---|---|
| [AGENTS.md](AGENTS.md) | Principles and policy — the canonical instructions |
| [.agents/rules/](.agents/rules/) | Path-scoped procedures (discovery, workflow, iteration) |
| [.agents/skills/](.agents/skills/) | Reusable playbooks, one `SKILL.md` per folder |
| [.agents/agents/](.agents/agents/) | Sub-agent definitions |
| [.agents/hooks/](.agents/hooks/) | Hook scripts, referenced by `.claude/settings.json` |
| [.agents/reference/](.agents/reference/) | Anti-slop rules, `.claude/` format conventions |
| [docs/](docs/) | Project facts: layout, ports, commands |

`.claude/` holds only Claude-Code-specific wiring: `settings.json`, and
directory symlinks into `.agents/` (`rules`, `skills`, `agents`) so
auto-discovery keeps working. Edit the `.agents/` originals, never the symlinks.

Those three are directories of lazily-read material: a rule or skill is read
when it is reached, and one file arrives once whichever path led to it. A memory
file is different in kind — it loads on sight, by path. Symlinking one into
`.claude/` therefore buys no discovery this file does not already provide, and
costs a second full copy in context every time anything under `.claude/` is
touched. So: symlink directories of lazily-read material; never symlink a memory
file.
