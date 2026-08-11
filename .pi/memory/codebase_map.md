# Codebase Map & File Registry

## 0. Last Synchronized Checkpoint

- **Last AI Analysis Timestamp**: August 11, 2026, 09:16 PM PST

## 1. Visual Codebase Overview

_Draw the entire project directory tree and explain each folder and file in one simple sentence. This is your bird's-eye view of the project._

### Directory Tree

```
pi-worrie/
├── extensions/                _Pi agent CLI TS extensions (loaded via package.json pi.extensions)_
│   ├── updater.ts             _/updater: runs `pi update --all` via shell exec, friendly output (44 lines)_
│   ├── persona-skills.ts      _/setup + /ask /plan /coder /debugger /orchestrator /orch-full /reviewer /secure /tester /normal + /memory * system (1232 lines)_
│   └── subagents.ts           _Child-pi subagent runner: single/parallel/chain modes, async, trust file (1271 lines)_
├── rules/                     _Packaged framework rules: .clinerules + system_instructions.md (loaded via pi.skills)_
├── skills/                    _8 persona skills (ask, coder, debugger, orchestrator, planner, reviewer, secure, tester) — mirror of .pi/skills for pi package loading_
├── templates/                 _Scaffolding sources for /setup: workspace.json (with __WORRIE_*__ tokens), archives/, memory/, rules/_ 
├── .pi/                       _Workspace instance of the framework (untracked before, now un-ignored)_
│   ├── rules/                 _Operational copies of .clinerules + system_instructions.md (differs slightly from rules/)_
│   ├── memory/                _7 dynamic memory layers: error, codebase_map, project, implementation, security, review, test_
│   ├── skills/                _8 persona skills used by this workspace_
│   ├── archives/              _5 pre-created archive files: error, implementation, security, review, test_
│   └── workspace.json         _Workspace identity marker (initialized: piworrie-setup)_
├── package.json               _pi-worrie v1.0.0: pi.extensions lists 3 extensions, pi.skills = ./skills, peer deps pi-coding-agent + pi-tui, dep typebox_
├── README.md                  _Documents all extensions + persona/memory command tables + read-only enforcement + status bar_
├── AGENTS.md                  _Workspace instruction loader (points to .pi/rules/.clinerules + system_instructions.md)_
├── .gitignore                 _Only node_modules/ (recently removed .pi/ + AGENTS.md lines so they become committable)_
└── LICENSE                    _MIT license_
```

### Folder & File Descriptions

| Path | What It Does |
|------|-------------|
| `extensions/updater.ts` | _Updater extension. Registers `/updater` command that runs `pi update --all` via `exec` from node:child_process (shell) with 120s timeout. Parses combined stdout+stderr: checks `added`/`audited` first → "Updates applied successfully.", else "Everything is up to date.". Errors surface as error notification. ERR-001 fix verified present._ |
| `extensions/persona-skills.ts` | _Persona + memory extension. Ask/plan run in main session (read-only tools); other personas spawn worrie-* subagents. Registers `/setup` (scaffolds .pi from templates), 11 persona commands, `/memory log/show/list/resolve/edit/search/archive/config`. Uses fs/path directly, MEMORY_TYPES + ARCHIVE_MAP tables drive file targeting, auto-assigns next tracking numbers._ |
| `extensions/subagents.ts` | _Subagent runner extension. Spawns child pi processes from .pi/agents/worrie-*.md. Modes: single, parallel (≤8 tasks, ≤4 concurrent), chain (per-step approval), async background. Constants: MAX_DEPTH 3, MAX_RETRIES_PER_STEP 5, trust file .pi/subagents-trust.json. Imports CONFIG_DIR_NAME, getAgentDir, parseFrontmatter from @earendil-works/pi-coding-agent; StringEnum from @earendil-works/pi-ai; Type from typebox._ |
| `rules/` | _Packaged immutable framework config: .clinerules (persona rules), system_instructions.md (context boundaries). Referenced by package.json pi.skills for pi-native skill loading._ |
| `skills/` | _8 persona skill dirs (ask, coder, debugger, orchestrator, planner, reviewer, secure, tester), each with SKILL.md. Published copy of the persona framework._ |
| `templates/` | _Source templates for `/setup`: workspace.json uses __WORRIE_SLUG__/__WORRIE_NAME__/__WORRIE_AT__/__WORRIE_BY__ placeholder tokens; subfolders archives/ (5 files), memory/ (6 files), rules/ (project_memory template). Never overwrites existing files._ |
| `.pi/` | _Live workspace instance of the framework — operational memory + rules + skills. Currently untracked in git (un-ignored, pending commit decision)._ |
| `package.json` | _pi-worrie v1.0.0, type: module. pi.extensions: updater.ts, persona-skills.ts, subagents.ts. pi.skills: ["./skills"]. Peer deps: @earendil-works/pi-coding-agent >=0.74.0, @earendil-works/pi-tui >=0.74.0. Dependency: typebox ^1.3.7 (used by subagents.ts for schema validation)._ |
| `README.md` | _Documents /updater, /setup, 11 persona commands with run-location column (main session vs worrie-* subagent), memory command table, read-only enforcement note, status bar behavior._ |
| `AGENTS.md` | _Pi workspace instruction loader — tells the agent to re-read .pi/rules/.clinerules + system_instructions.md on context loss or flag prompts._ |
| `.gitignore` | _Now only node_modules/. The .pi/ and AGENTS.md ignore lines were removed (git diff shows the deletion) — intent: commit framework files into the extension repo._ |
| `LICENSE` | _MIT license, copyright worriee 2025._ |

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

- **Critical Third-Party Libraries**: `@earendil-works/pi-coding-agent` (ExtensionAPI, agent dir helpers — peer dep, the host pi CLI), `@earendil-works/pi-tui` (peer dep, UI), `typebox` (schema builder used by subagents.ts to validate agent configs).
- **Tricky Code Paths**: `subagents.ts` spawns child pi processes from markdown agent files — trust file (`subagents-trust.json`) gates execution; `persona-skills.ts` reads/writes `.pi/` memory files with fs directly and auto-increments tracking numbers (ERR-XXX etc.) by scanning existing headers; repo has two parallel rule copies (`rules/` vs `.pi/rules/`) that currently differ — keep them aligned.
<!-- c: worrie -->
