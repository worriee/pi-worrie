# Codebase Map & File Registry

## 0. Last Synchronized Checkpoint

- **Last AI Analysis Timestamp**: August 13, 2026, 03:57 PM PST

## 1. Visual Codebase Overview

_Draw the entire project directory tree and explain each folder and file in one simple sentence. This is your bird's-eye view of the project._

### Directory Tree

```
pi-worrie/
├── extensions/                _Pi agent CLI TS extensions (loaded via package.json pi.extensions)_
│   ├── updater.ts             _/updater: runs `pi update --all` via shell exec, friendly output (44 lines)_
│   ├── persona-skills.ts      _/setup + 11 persona commands + /memory * system + /clean (1545 lines — has uncommitted edits in working tree)_
│   └── subagents.ts           _Child-pi subagent runner: single/parallel/chain modes, async, trust file (1271 lines)_
├── rules/                     _PACKAGED framework rules (new agent-file flow): .clinerules (147 ln, LF) + system_instructions.md (104 ln, LF). /setup merges them into every generated .pi/agents/worrie-*.md file_
├── skills/                    _8 persona skills (ask, coder, debugger, orchestrator, planner, reviewer, secure, tester) — byte-identical to .pi/skills/_
├── templates/                 _Scaffolding sources for /setup: workspace.json (with __WORRIE_*__ tokens), archives/ (5 files), memory/ (6 files), rules/ (project_memory.md ONLY — no .clinerules/system_instructions.md here by design)_
├── .pi/                       _Workspace instance of the framework — author's LIVE standalone rules (old persona-flag flow) + memory layers_
│   ├── rules/                 _Live operational rules: .clinerules (158 ln, CRLF) + system_instructions.md (115 ln, CRLF) + project_memory.md — differs from rules/ (see comparison block below)_
│   ├── memory/                _5 dynamic memory layers: error, codebase_map, implementation, security, review (project_memory.md lives in .pi/rules/)_
│   ├── skills/                _8 persona skills used by this workspace — byte-identical to repo skills/_
│   ├── archives/              _5 pre-created archive files: error, implementation, security, review, test_
│   └── workspace.json         _Workspace identity marker (initialized: piworrie-setup, immutable)_
├── package.json               _pi-worrie v1.0.0 (40 ln): pi.extensions = 3 files, pi.skills = ./skills, peer deps pi-coding-agent + pi-tui (>=0.74.0 <1), dep typebox ^1.3.7_
├── README.md                  _118 ln: documents /updater, /setup, 11 persona commands, memory commands, subagent modes_
├── AGENTS.md                  _30 ln: workspace instruction loader (points to .pi/rules/.clinerules + system_instructions.md)_
├── .gitignore                 _1 line: only node_modules/_
└── LICENSE                    _MIT license (21 ln), copyright worriee 2025_
```

### Folder & File Descriptions

| Path | What It Does |
|------|-------------|
| `extensions/updater.ts` | _Updater extension. Registers `/updater` command that runs `pi update --all` via `exec` from node:child_process (shell) with 120s timeout. Parses combined stdout+stderr: checks `added`/`audited` first → "Updates applied successfully.", else "Everything is up to date.". Errors surface as error notification. ERR-001 fix verified present._ |
| `extensions/persona-skills.ts` | _Persona + memory extension (1545 lines). Ask/plan run in main session (read-only tools); other personas delegate to worrie-* subagents. Registers `/setup` (scaffolds .pi from templates + generates 7 agent files in .pi/agents/), 11 persona commands, `/memory log/show/list/resolve/edit/search/archive/config`, `/clean`. Uses fs/path directly; AGENT_SPECS + buildAgentFile assemble each agent = skill persona + tools + memory protocol + slim WORKSPACE RULES block; loadWorkspaceRules() joins rules/.clinerules + rules/system_instructions.md; buildSubagentRules() keeps only 8 subagent-relevant H2 sections. Has UNCOMMITTED working-tree edits (git: M)._ |
| `extensions/subagents.ts` | _Subagent runner extension. Spawns child pi processes from .pi/agents/worrie-*.md. Modes: single, parallel (≤8 tasks, ≤4 concurrent), chain (per-step approval), async background. Constants: MAX_DEPTH 3, MAX_RETRIES_PER_STEP 5, trust file .pi/subagents-trust.json. Imports CONFIG_DIR_NAME, getAgentDir, parseFrontmatter from @earendil-works/pi-coding-agent; StringEnum from @earendil-works/pi-ai; Type from typebox._ |
| `rules/` | _PACKAGED immutable framework rules: .clinerules (147 ln, LF) + system_instructions.md (104 ln, LF) — new agent-file flow. NOT copied into `.pi/rules/` by /setup; instead both files are joined and embedded (slimmed to 8 H2 sections) into every `.pi/agents/worrie-*.md`. References `.pi/agents/worrie-*.md` as ground truth._ |
| `skills/` | _8 persona skill dirs (ask, coder, debugger, orchestrator, planner, reviewer, secure, tester), each with SKILL.md — byte-identical to `.pi/skills/`. Persona prompts injected into agent files by /setup._ |
| `templates/` | _Source templates for `/setup`: workspace.json uses __WORRIE_SLUG__/__WORRIE_NAME__/__WORRIE_AT__/__WORRIE_BY__ tokens; subfolders archives/ (5 files), memory/ (6 files), rules/ (ONLY project_memory.md — the two rules files are intentionally absent; they merge into agent files instead). Never overwrites existing files._ |
| `.pi/` | _Live workspace instance of the framework — git-tracked. Contains old-flow standalone rules + memory + skills + archives. NO `.pi/agents/` directory yet (subagents.ts/rules/README reference it; running /setup here would create the 7 worrie-*.md files)._ |
| `package.json` | _pi-worrie v1.0.0 (40 lines), type: module. pi.extensions: updater.ts, persona-skills.ts, subagents.ts. pi.skills: ["./skills"]. Peer deps: @earendil-works/pi-coding-agent >=0.74.0 <1, @earendil-works/pi-tui >=0.74.0 <1. Dependency: typebox ^1.3.7 (used by subagents.ts for schema validation)._ |
| `README.md` | _118 lines. Documents /updater, /setup, persona command table with run-location column (main session vs worrie-* subagent), memory command table, subagent modes (single/parallel/chain/background), installation, requirements._ |
| `AGENTS.md` | _30 lines. Pi workspace instruction loader — tells the agent to re-read .pi/rules/.clinerules + system_instructions.md on context loss or flag prompts._ |
| `.gitignore` | _1 line: `node_modules/` only. .pi/ and AGENTS.md are tracked and committed._ |
| `LICENSE` | _MIT license, copyright worriee 2025._ |

### Rules File Comparison: `.pi/rules/` (live) vs `rules/` (packaged)

_How the two copies of the framework rules relate, in plain language._

**Same core, two deliveries.** Both pairs contain the SAME framework rules text: `.clinerules` (all 15 H2 sections shared) and `system_instructions.md` (sections 1, 3, 4, 5, 6 shared). Only difference in raw bytes: `.pi/rules/` uses CRLF line endings, `rules/` uses LF.

**Three real content differences:**

1. **Persona flag mapping exists ONLY in `.pi/rules/`** — `.pi/rules/.clinerules` has an extra `## Persona Execution Mode Selection` section (maps flags `-o -p -c -d -a -s -r -t` to `.pi/skills/*/SKILL.md`) and `.pi/rules/system_instructions.md` has an extra `## 2. Persona Selection Matrix` section. These sections were DELIBERATELY REMOVED from `rules/` because in the packaged flow personas are dedicated agent files (`.pi/agents/worrie-*.md`), not flag-triggered skill lookups.
2. **Ground-truth re-read target differs** — on context loss, `rules/` commands re-read `## WORKSPACE RULES` inside `.pi/agents/worrie-*.md`; `.pi/rules/` commands re-read `.pi/rules/.clinerules` itself.
3. **Mutation ban target differs** — `rules/` bans editing `.pi/agents/worrie-*.md`; `.pi/rules/` bans editing `.pi/rules/` + `.pi/skills/*`.

**Why both exist.** `rules/` is the PACKAGED source: `/setup` (persona-skills.ts:358 loadWorkspaceRules) joins both files, slims them to 8 subagent-relevant H2 sections (System Boundaries, Strict Rule Modification, Timestamp, LIFO, Beginner Clarity, Section Title Protection, Data Retention, Immediate Resolution), and embeds them into each generated agent file. `.pi/rules/` is THIS workspace's LIVE standalone framework — the files I (the agent) read as ground truth via AGENTS.md. Same rules, two flows: packaged-merge vs live-standalone.

**State check:** `.pi/agents/` does NOT exist in this repo — the new flow is only half-materialized here. Running `/setup` in pi would create the 7 `worrie-*.md` agent files (workspace.json already initialized → skipped; memory/archives already exist → kept; agents created with rules block). `skills/` ↔ `.pi/skills/` have ZERO drift (8/8 byte-identical); `rules/` ↔ `.pi/rules/` is the only divergent pair.

---

## 2. Frontend Layer

### 1A. Logic, Functions & Code Structures

_Detailed documentation of every frontend logic, function, and code structure used in this project._

#### [FN-FE-001] Function/Logic Name

- **Purpose**: _What does this logic/function do?_
- **Location**: _File path where defined_
- **Input/Output**: _Parameters and return values_
- **Dependencies**: _What other functions/files does it rely on?_
- **Called By**: _Which components or functions invoke this?_
- **Side Effects**: _Any state mutations, API calls, or storage operations_

---

### 1B. File Registry & Connection Mapping

_Every frontend file and how it connects to the logics/functions documented in 1A above._

#### [FILE-FE-001] File Name

- **Path**: _Full relative path from project root_
- **Purpose**: _What does this file do?_
- **Functions Contained**: _References to FN-FE-XXX entries above_
- **Imports From**: _Other files it depends on_
- **Exports To**: _Files/components that import from this_
- **UI Role**: _What component, page, or feature does this file serve?_

---

## 3. Backend Layer

### 2A. Logic, Functions & Code Structures

_Detailed documentation of every backend logic, function, and code structure used in this project._

#### [FN-BE-001] Function/Logic Name

- **Purpose**: _What does this logic/function do?_
- **Location**: _File path where defined_
- **Input/Output**: _Parameters and return values_
- **Dependencies**: _What other functions/files does it rely on?_
- **Called By**: _Which endpoints, jobs, or processes invoke this?_
- **Side Effects**: _Any database mutations, cache operations, or external API calls_

---

### 2B. File Registry & Connection Mapping

_Every backend file and how it connects to the logics/functions documented in 2A above._

#### [FILE-BE-001] File Name

- **Path**: _Full relative path from project root_
- **Purpose**: _What does this file do?_
- **Functions Contained**: _References to FN-BE-XXX entries above_
- **Imports From**: _Other files it depends on_
- **Exports To**: _Files/services that import from this_
- **API Role**: _What endpoint, job, or service does this file serve?_

---

## 4. Data & Platform Layer

### 3A. Database Schema & Data Models

_Documents every database, table/collection, schema design, entity relationships, and ORM/ODM mappings used in this project._

#### [DB-001] Table/Collection Name

- **Database Type**: _[PostgreSQL, MongoDB, SQLite, etc.]_
- **Purpose**: _What this stores and why_
- **Schema Fields**: _Column/field name, type, constraints, defaults_
- **Relationships**: _Foreign keys, references to other tables or collections_
- **Indexes**: _Performance indexes defined_
- **ORM Model**: _File path of the model or schema definition_
- **Used By**: _Which backend functions query this (references to FN-BE-XXX)_

---

### 3B. Storage & File Management

_Documents file storage, asset pipelines, CDN, and cache layers._

#### [STG-001] Storage Service Name

- **Service/Provider**: _[Local disk, AWS S3, Cloudinary, Vercel Blob, etc.]_
- **Purpose**: _What kind of files are stored here_
- **Access Pattern**: _How files are uploaded, retrieved, and served_
- **Security**: _Public vs. private, signed URLs, access control_
- **Integration File**: _File path handling storage operations and configuration_

---

### 3C. Third-Party Services & Integrations

_Documents every external API, auth provider, payment gateway, webhook, and SaaS integration._

#### [SVC-001] Service Name

- **Provider**: _[Auth0, Stripe, Resend, OpenAI, etc.]_
- **Purpose**: _What this service does for the application_
- **Integration File**: _File path where this is configured or called_
- **Auth Method**: _API key, OAuth, JWT, webhook secret_
- **Environment Variables Needed**: _Keys and secrets (list names only, never actual values)_
- **Cost/Rate Limits**: _Any usage constraints or pricing model_

---

### 3D. Hosting & Deployment Environment

_Documents cloud platforms, domains, deployment pipelines, and environment configuration._

#### [DEP-001] Environment / Platform

- **Provider**: _[Vercel, Railway, AWS EC2, Netlify, etc.]_
- **Purpose**: _What runs here (frontend, backend, database, etc.)_
- **Domain**: _Custom domain or subdomain_
- **Deploy Method**: _Git push, CI/CD, Docker, manual_
- **Environment Variables**: _Required env vars (names only, never actual values)_
- **Build Command**: _How the project is built for this platform_
- **Health Check**: _URL or command to verify it is running_

---

### 3E. DevOps & Infrastructure Tooling

_Documents Docker, CI/CD pipelines, monitoring, logging, and orchestration._

#### [OPS-001] Tool / Config Name

- **Tool**: _[Docker, GitHub Actions, Nginx, Sentry, etc.]_
- **Purpose**: _What it automates or monitors_
- **Config File**: _Path to the configuration file_
- **Key Commands**: _Common CLI commands for this tool_

---

## 5. Learning Notes & Dependency Mapping

- **Rules architecture split (as of Aug 13, 2026 sync)**: `.pi/rules/` (live, persona-flag flow, CRLF) vs `rules/` (packaged, agent-merge flow, LF) — SAME core rules, intentional split. Only person-flag sections + ground-truth/mutation-ban targets differ. Full comparison documented under Section 1 → "Rules File Comparison". `skills/` ↔ `.pi/skills/` are byte-identical (8/8) — no sync work needed there.
- **`.pi/agents/` missing in this repo**: `rules/`, `subagents.ts`, and README all reference `.pi/agents/worrie-*.md`, but directory does not exist here. `/setup` run in this workspace would generate the 7 agent files and refresh their WORKSPACE RULES block. Until then, persona delegation commands cannot spawn subagents.
- **Uncommitted work**: `extensions/persona-skills.ts` has working-tree edits (git: ` M`) not yet committed; HEAD is 770a374 "fix: refine agent instructions and remove bloats".
- **Critical Third-Party Libraries**: `@earendil-works/pi-coding-agent` (ExtensionAPI, agent dir helpers — peer dep, the host pi CLI), `@earendil-works/pi-tui` (peer dep, UI), `typebox` (schema builder used by subagents.ts to validate agent configs).
- **Tricky Code Paths**: `subagents.ts` spawns child pi processes from markdown agent files — trust file (`subagents-trust.json`) gates execution; `persona-skills.ts` reads/writes `.pi/` memory files with fs directly and auto-increments tracking numbers (ERR-XXX etc.) by scanning existing headers; `/setup` merges `rules/` into generated agent files via loadWorkspaceRules + buildSubagentRules (8 H2 sections kept, rest is main-session meta-work).
<!-- c: worrie -->
