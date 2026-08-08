# pi-worrie

My personal Pi extensions.

> mostly AI generated codes.

---

## Extensions

### Pi - Updater

Run updates inside pi directly without needing the terminal. Updates extensions and pi itself.

**Commands:**

- **`/updater`** — Runs `pi update --all`. Notifies when done.

---

### Pi - Persona Skills

> the same as [uveworkflow](https://github.com/worriee/uveworkflow) but inside Pi.

**First run:**

- **`/setup`** — Initialize workspace. Creates `.pi/workspace.json`, memory files, archive files, and the 7 `worrie-*` agent files in `.pi/agents/` (planner, coder, debugger, orchestrator, reviewer, secure, tester). Never overwrites existing files.

**Personas:**

| Command                  | What it does                                                                                                                                         | Runs in                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `/ask <question>`        | Read-only analysis, can find/locate files                                                                                                            | main session                 |
| `/plan <task>`           | Read-only planning, waits for approval                                                                                                               | main session                 |
| `/coder <task>`          | Implementation                                                                                                                                       | worrie-coder subagent        |
| `/debugger <problem>`    | Bug fixing, root-cause analysis                                                                                                                      | worrie-debugger subagent     |
| `/orchestrator <prompt>` | Auto-detects the right persona from your prompt                                                                                                      | worrie-orchestrator subagent |
| `/orch-full <task>`      | Full 11-stage pipeline: PLAN -> CODE -> TEST -> DEBUG -> SECURE -> DEBUG -> TEST -> CLEAN -> REVIEW -> DOCUMENT -> ASK (approval before every stage) | worrie-orchestrator subagent |
| `/reviewer <target>`     | Code review (read-only on source)                                                                                                                    | worrie-reviewer subagent     |
| `/secure <target>`       | Security scan, score 0-10                                                                                                                            | worrie-secure subagent       |
| `/tester <target>`       | Test pipeline: typecheck -> lint -> unit -> integration -> E2E -> coverage                                                                           | worrie-tester subagent       |
| `/normal`                | Exit persona mode, restore all tools                                                                                                                 | main session                 |

**Read-only enforcement:** `/ask` and `/plan` get `read`, `grep`, `find`, `ls` only. Write, edit, and bash are blocked at the tool level. They can still write memory when you explicitly tell them to.

**Status bar:** persona state, subagent activity, memory auto-log state, and orchestrator stage progress are shown in the footer (e.g. `[CODER] active`, `[ORCH-FULL] stage 3/11: TEST`).

**Memory:**

| Command                                                         | What it does                                   |
| --------------------------------------------------------------- | ---------------------------------------------- |
| `/memory log <err\|code\|impl\|sec\|rev\|test\|proj> "message"` | Create entry, auto-assign next tracking number |
| `/memory show <type> [n\|--all\|--open\|--resolved\|ID]`        | View entries                                   |
| `/memory list`                                                  | All memory files with open/resolved counts     |
| `/memory resolve <type> <ID>`                                   | Move entry to Section 2 as RESOLVED            |
| `/memory edit <type> <ID> "Field: value"`                       | Update a field                                 |
| `/memory search <type> <query>`                                 | Search entries                                 |
| `/memory archive`                                               | Archive overflow (threshold: 10, configurable) |
| `/memory config [autoLog\|promptOnBlock\|maxEntries\|reset]`    | Toggle auto-log prompts, set archive threshold |

Memory types: `err` (error_memory.md), `code` (codebase_map.md), `impl` (implementation_memory.md), `sec` (security_memory.md), `rev` (review_memory.md), `test` (test_memory.md), `proj` (project_memory.md). Entries use LIFO ordering, `### [RESOLVED] Title (ERR-XXX)` migration, and history is never deleted.

**Clean:**

- **`/clean`** — Scans for junk files (`.bak`, `.tmp`, `.log`, empty files) and debug traces (console.*, debugger, TODO, FIXME). Shows the list, asks your approval, removes approved junk files only. Source files are never touched.

**Memory config:**

- `autoLog` — after read-only persona work, asks "Save to memory?" (default ON)
- `promptOnBlock` — shows `[BLOCKED]` status when a read-only persona tries to write (default ON)
- `maxEntries` — archive threshold, default 10

---

### Pi - Subagents

> Self-contained subagent tool. Launches agents from `.pi/agents/` (or `~/.pi/agent/agents/`) as isolated child pi processes. Concept inspired by [pi-subagents](https://github.com/nicobailon/pi-subagents).

**Modes:**

| Mode       | What it does                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single     | One agent, one task                                                                                                                                           |
| Parallel   | Several agents at once (max 8, 4 concurrent)                                                                                                                  |
| Chain      | Sequential steps; Takes previous subagent finished summary task then pass it to next subagent, performs well with `/orch-full` command for 11 pipeline stages |
| Background | Runs in background, widget shows progress, collect with `subagent_wait`                                                                                       |

**Commands:**

- **`/subagents`** — Lists running subagents. Pick one to see its latest output (maximize).

**Guardrails:**

- Depth cap 3 (no infinite subagent loops)
- Trust dialog on first project-agent use: "Trust once" or "Trust always" (stored in `.pi/subagents-trust.json`)
- 50KB output cap per agent; `{previous}` capped at 8KB
- Chain approval dialogs: Continue / Re-run (max 5) / Abort

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
