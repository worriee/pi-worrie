# Project Memory & Context Tracker

## 0. Last Synchronized Checkpoint

- **Last AI Analysis Timestamp**: August 11, 2026, 09:16 PM PST

## 1. Project Overview

### Project Identity

- **Project Name**: piworrie-setup
- **Primary Goal**: Single mono-extension repo for worrie's Pi agent CLI extensions (rewind + updater)
- **Target Users / Audience**: worrie (personal Pi agent workspace)
- **Current Phase**: Alpha
- **Active Branch**: main

### Key Constraints

- Must be loadable by Pi agent CLI as a single `pi install` package
- Extensions use `ExtensionAPI` from `@earendil-works/pi-coding-agent >=0.74.0`
- Must run on Windows (Pi agent CLI environment)

---

## 2. Active Milestones & Roadmap

### [MS-002] Pi-First Architecture: rules + skills + templates packaged for /setup

- **Target Version/Release**: v1.0.0
- **Due Date**: TBD
- **Key Deliverables**: Repo-root `rules/`, `skills/`, `templates/` dirs; package.json `pi.skills` points to `./skills`; `/setup` in persona-skills.ts scaffolds `.pi/workspace.json`, memory files, archive files, and 7 `worrie-*` agent files from templates (never overwrites existing)
- **Dependencies**: MS-001
- **Status**: IN_PROGRESS
- **Notes**: `.pi/` was un-ignored in .gitignore (removed `.pi/` + `AGENTS.md` lines) so framework files can be committed to the extension repo. Repo-root `rules/` copies differ slightly from `.pi/rules/` copies — keep them in sync.

### [MS-001] Monorepo Consolidation

- **Target Version/Release**: v1.0.0
- **Due Date**: TBD
- **Key Deliverables**: Merged pi-updater + uveworkflow personas (persona-skills.ts) + subagent runner (subagents.ts) into pi-worrie with working package.json and README
- **Dependencies**: None
- **Status**: COMPLETED
- **Notes**: rewind.ts was removed from this repo (undo/redo lives elsewhere). 3 extensions now registered in package.json: updater, persona-skills, subagents. Updater output parsing (ERR-001) verified fixed in code — checks `added`/`audited` before `up to date`.

---

## 3. Current Sprint & Active Tasks

- Sync: `.pi/rules/` copies vs repo-root `rules/` copies — check drift direction and align
- Decide: commit untracked `.pi/` + `AGENTS.md` (now un-ignored) or keep local-only
- Verify: `/setup` scaffolding works end-to-end (templates → .pi creation) in a fresh clone

---

## 4. Completed Milestones

- **MS-001 Monorepo Consolidation** (Aug 11, 2026) — 3 extensions merged into pi-worrie v1.0.0; rewind removed; README + package.json consistent; updater ERR-001 fix verified in code

---

## 5. Pending Tasks & Backlog

- Add rewind extension back? (removed from repo — confirm if intentional)
- Run `-archive` check once active memory entries exceed 10 per section
- End-to-end `/setup` test in fresh workspace

---

## 6. Architectural Decisions & Constraints

### [DEC-002] Template-Driven Workspace Scaffolding

- **Context**: Persona-skills `/setup` command creates `.pi/` state files on first run
- **Choice Made**: Copy from repo-root `templates/` (workspace.json, memory, archives) and `rules/` + `skills/` — placeholder tokens `__WORRIE_SLUG__` etc. replaced at runtime; never overwrites existing files
- **Alternatives Considered**: Generating files inline in code — rejected, bloats the extension and diverges from the canonical framework files
- **Impact**: Repo keeps 3 mirror dirs (`rules/`, `skills/`, `templates/`) alongside `.pi/`; package.json `pi.skills: ["./skills"]` loads personas as native pi skills
- **Date Logged**: August 11, 2026, 09:16 PM PST

### [DEC-001] Shell Execution for `pi` CLI Command

- **Context**: Updater extension must run `pi update --all` via shell to resolve global npm binary PATH
- **Choice Made**: Use `exec` from `node:child_process` (shell execution) instead of `pi.exec` (direct spawn)
- **Alternatives Considered**: `pi.exec("pi", ["update", "--all"])` — fails because `pi` binary not in spawned process PATH
- **Impact**: `extensions/updater.ts` import changed from `ExtensionAPI` only to also include `exec` from `node:child_process`
- **Date Logged**: July 20, 2026, 05:24 PM PST

---

## 7. MEMORY FILE REGISTRY

All specialized memory logs are stored in `.pi/memory/` directory:

- **Error Memory**: `.pi/memory/error_memory.md` — Active bugs, stack traces, resolution history
- **Codebase Map**: `.pi/memory/codebase_map.md` — Directory structure, file purposes, dependency mapping
- **Implementation Memory**: `.pi/memory/implementation_memory.md` — Architectural design maps, feature flows, execution roadmaps
- **Security Memory**: `.pi/memory/security_memory.md` — Vulnerability tracking, threat modeling, remediation plans
- **Review Memory**: `.pi/memory/review_memory.md` — Code review findings, quality assessments
- **Test Memory**: `.pi/memory/test_memory.md` — Test strategies, coverage analysis, test case documentation

**Archive Files** (pre-created, receive overflow from memory files):

- **Error Archive**: `.pi/archives/error_archive.md`
- **Implementation Archive**: `.pi/archives/implementation_archive.md`
- **Security Archive**: `.pi/archives/security_archive.md`
- **Review Archive**: `.pi/archives/review_archive.md`
- **Test Archive**: `.pi/archives/test_archive.md`

_Note: `codebase_map.md` and `project_memory.md` are excluded from archival._

---

## 8. ARCHIVE STATUS

- **Archive Location**: `.pi/archives/`
- **Threshold**: 10 active entries per section (LIFO ordering)
- **Archives Created**: 0
- **Last Archive Check**: `Not yet performed`

| Archive File        | Source Memory | Entries Archived | Archived At (PST) |
| ------------------- | ------------- | ---------------- | ----------------- |
| _(No archives yet)_ |               |                  |                   |

<!-- c: worrie -->
