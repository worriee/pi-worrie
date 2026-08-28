# pi-worrie

My personal agentic workflow. The same as [uveworkflow](https://github.com/worriee/uveworkflow) but better :>

If you wanna try then install [here.](#installation)

> mostly AI generated.

---

## Extensions

### Pi - Updater

Run updates inside pi directly without needing the terminal. Updates extensions and pi itself.

**Commands:**

- **`/updater`** — Runs `pi update --all`. Notifies when done.

---

### Pi - Persona Skills

> Single-letter persona commands match uveworkflow flags. Same flow, shorter names.

**First run:**

- **`/setup`** — Initialize workspace. Creates `.pi/workspace.json`, memory files, archive files, and the 7 `worrie-*` agent files in `.pi/agents/` (planner, coder, debugger, orchestrator, reviewer, secure, tester). Never overwrites existing files.

**Personas:**

| Command          | What it does                                                                                                                                         | Runs in                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `/a <question>`  | Read-only analysis, can find/locate files                                                                                                            | main session                 |
| `/p <task>`      | Read-only planning, waits for approval                                                                                                               | main session                 |
| `/c <task>`      | Implementation                                                                                                                                       | worrie-coder subagent        |
| `/d <problem>`   | Bug fixing, root-cause analysis                                                                                                                      | worrie-debugger subagent     |
| `/o <prompt>`    | Auto-detects the right persona from your prompt                                                                                                      | worrie-orchestrator subagent |
| `/o auto <task>` | Full 11-stage pipeline: PLAN -> CODE -> TEST -> DEBUG -> SECURE -> DEBUG -> TEST -> CLEAN -> REVIEW -> DOCUMENT -> ASK (approval before every stage) | worrie-orchestrator subagent |
| `/r <target>`    | Code review (read-only on source)                                                                                                                    | worrie-reviewer subagent     |
| `/s <target>`    | Security scan, score 0-10                                                                                                                            | worrie-secure subagent       |
| `/t <target>`    | Test pipeline: typecheck -> lint -> unit -> integration -> E2E -> coverage                                                                           | worrie-tester subagent       |
| `/normal`        | Exit persona mode, restore all tools                                                                                                                 | main session                 |

**Read-only enforcement:** `/a` and `/p` get `read`, `grep`, `find`, `ls` only. Write, edit, and bash are blocked at the tool level.

**Status bar:** 2 segments — `worrie-status` (persona mode or `[NORMAL]`) + `worrie-subagent` (only when subagent working). Persona status persists until `/normal`. Utility status clears when done.

**Memory:**

| Command                                          | What it does                                   |
| ------------------------------------------------ | ---------------------------------------------- |
| `/context`                                        | Prompt → update project_memory.md              |
| `/error`                                          | Prompt → log to error_memory.md                |
| `/codebase`                                       | Prompt → update codebase_map.md                |
| `/m list [type] [--active\|--resolved\|--all]`      | View entries as table                          |
| `/m resolve <ERR-XXX \| SEC-XXX \| ...>`           | Resolve entry manually (AI-free)               |
| `/ml [type] [--active\|--resolved\|--all]`          | Shorthand for `/m list`                        |
| `/archive`                                        | Archive overflow (threshold: 10, configurable) |
| `/m config [promptOnBlock\|maxEntries\|reset]`      | Toggle settings                                |

Memory types: `err` (error_memory.md), `code` (codebase_map.md), `impl` (implementation_memory.md), `sec` (security_memory.md), `rev` (review_memory.md), `test` (test_memory.md), `proj` (project_memory.md). Logging is AI-managed — the AI itself appends new entries with its own tracking IDs (uveworkflow style). Entries use LIFO ordering, `### [RESOLVED] Title (ERR-XXX)` migration, and history is never deleted.

**Utilities:**

- **`/init`** — Initialize workspace.json only (without creating memory/agent files).
- **`/clean`** — Scans for junk files (`.bak`, `.tmp`, `.log`, empty files) and debug traces (console.*, debugger, TODO, FIXME). Shows the list, asks your approval, removes approved junk files only. Source files are never touched.
- **`/obsidian`** — Mirrors your workspace (memory logs, archives, project_memory, workspace.json, agent files, AGENTS.md) into `<vault>/<project_name>/` in your Obsidian vault. Asks for the vault path once, remembers it, always overwrites with the latest version. Run `/setup` first.
- **`/update`** — Fetches latest templates from [uveworkflow](https://github.com/worriee/uveworkflow) repo and updates source files (rules, skills, templates). Preserves installed workspace memory files.
- **`/rules`** — Choose which rules the main session follows: default `.pi` rules (embedded slim rule set from the package), or a project `AGENTS.md` / `CLAUDE.md` (only shown if present). Enforced via pi's native `AGENTS.override.md` slot in the project root (auto-restored on session start).

---

### Pi - Subagents

> Self-contained subagent tool. Launches agents from `.pi/agents/` (or `~/.pi/agent/agents/`) as isolated child pi processes. Concept inspired by [pi-subagents](https://github.com/nicobailon/pi-subagents).

**Modes:**

| Mode       | What it does                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single     | One agent, one task                                                                                                                                           |
| Parallel   | Several agents at once (max 8, 4 concurrent)                                                                                                                  |
| Chain      | Sequential steps; Takes previous subagent finished summary task then pass it to next subagent, performs well with `/o auto` command for 11 pipeline stages |
| Background | Runs in background, widget shows progress, collect with `subagent_wait`                                                                                       |

**Commands:**

- **`/subagents`** — Lists running subagents. Pick one to see its latest output (maximize).

**Guardrails:**

- Depth cap 3 (no infinite subagent loops)
- Trust dialog on first project-agent use: "Trust once" or "Trust always" (stored in `.pi/subagents-trust.json`)
- 50KB output cap per agent; `{previous}` capped at 8KB
- Chain approval dialogs: Continue / Re-run (max 5) / Abort

---

### Pi - Worrie Themed

> Custom status bar footer. Replaces pi's default footer with your own project line and hides other extensions' footer statuses while active.

- **`/worrie-themed`** — Opens an On/Off dropdown. Swaps the default footer for a worrie status bar: `folder/project : git branch | 0.0%/200k | (provider) model` plus your worrie persona statuses.
- **`/worrie-themed on|off`** — Toggle directly without the dropdown.

Setting persists across sessions (stored in `.pi/worrie-themed.json`) until turned off.

---

## Installation

```bash
pi install git:github.com/worriee/pi-worrie
```

After installing: run `/setup`.

## Requirements

- Pi >= 0.74.0 (extension support)
- pi-subagents package (for the `worrie-*` subagents)

## Credit

By [**Worrie**](https://github.com/worriee)
