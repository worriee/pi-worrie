# pi-worrie

My personal agentic workflow. The same as [uveworkflow](https://github.com/worriee/uveworkflow) but better.

_DISCONTINUED. Not enough ram for local ai and broke enough to buy credits. Will continue this soon._

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

> Single-letter persona commands match uveworkflow flags. Same flow, shorter names. Now managed by `agents.ts` with all sources under `extensions/embed/`.

**First run:**

- **`/init`** — Creates the workspace identity only: `.pi/workspace.json` + `.pi/memory/` (7 files incl. `project_memory.md`) + `.pi/archives/` (5 files). NEVER writes rules or agent files into your project. `/setup` is an alias.

**How rules reach the AI (no workspace `AGENTS.md` or `.pi/rules/` files):**

`agents.ts` injects the full embedded rules (uveworkflow `instructions.md` + `pi-worrie Flag Mapping`) into EVERY pi session's system prompt, always. Persona agents (`worrie-*`) are installed **globally** to `~/.pi/agent/agents/` when the extension loads and are refreshed by `/update` — so delegation works in any project with zero workspace writes. Cost: the rules ride along in every session (~15-20K tokens).

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

Logging is fully AI-managed (uveworkflow style, no manual commands): the AI appends new findings FIRST (LIFO, `### [TYPE-XXX]`), then presents them — see the `FINDINGS GATE` section in the rules. On fix, resolved entries migrate to Section 2 SAME response; history is never deleted. `/d`, `/r`, `/s`, `/t` trigger this automatically.

| Command    | What it does                                      |
| ---------- | ------------------------------------------------- |
| `/context` | Flag-triggered git scan → fills `project_memory.md` §1 (Recent Changes) |
| `/error`   | Flag-triggered scan → updates `error_memory.md`   |
| `/codebase`| Flag-triggered structure inspection → `codebase_map.md` |
| `/archive` | Archive overflow (threshold: 10 per section) — maps to upstream `-archive` |

Memory types: `err` (error_memory.md), `code` (codebase_map.md), `impl` (implementation_memory.md), `sec` (security_memory.md), `rev` (review_memory.md), `test` (test_memory.md), `proj` (project_memory.md).

**Utilities:**

- **`/clean`** — Scans for junk files (`.bak`, `.tmp`, `.log`, empty files) and debug traces (console.*, debugger, TODO, FIXME). Shows the list, asks your approval, removes approved junk files only. Source files are never touched. Maps to upstream `System Clean`.
- **`/obsidian`** — Mirrors your workspace (memory logs, archives, project_memory, workspace.json) into `<vault>/<project_name>/` in your Obsidian vault. Asks for the vault root once and writes it into the `Vault Root` placeholder in `project_memory.md` §3 (`Backup Root` is left for a future backup feature). Run `/init` first.
- **`/update`** — Fetches the latest `.pi/` from [uveworkflow](https://github.com/worriee/uveworkflow), refreshes the extension's internal `embed/` rules+skills and `templates/` memory+archives, and regenerates the global `worrie-*` agent files. Zero workspace writes.
- **`/setup`** — Alias for `/init`.

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

After installing: run `/init`.

Rules live inside the extension and are injected into every session — nothing about the workflow is generated into your project except `workspace.json`, `.pi/memory/` and `.pi/archives/`. Old workspaces may still carry a stale `AGENTS.override.md` or pointer blocks from previous versions; delete those manually.

## Requirements

- Pi >= 1.2.0 (extension support)
- pi-subagents package (for the `worrie-*` subagents)

## Credit

By [**Worrie**](https://github.com/worriee)
