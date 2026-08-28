// Personas + memory system for pi-worrie. c: worrie
// Ask/plan run here. Other personas delegate to worrie-* subagents.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "fs";
import { join, dirname, extname } from "path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ===================================================================
// Constants
// ===================================================================

const CWD = process.cwd();
const CONFIG_DIR = join(CWD, ".pi");
const MEMORY_DIR = join(CONFIG_DIR, "memory");
const AGENTS_DIR = join(CONFIG_DIR, "agents");
const ARCHIVES_DIR = join(CONFIG_DIR, "archives");
const WORKSPACE_FILE = join(CONFIG_DIR, "workspace.json");

/** Read project_name from workspace.json, tolerating the trailing c: worrie comment. */
/** Parse workspace.json tolerating the trailing c: worrie comment. Null if missing/broken. */
function readWorkspace(): any {
  try {
    const raw = readFileSync(WORKSPACE_FILE, "utf8");
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
}

function readWorkspaceName(): string {
  return readWorkspace()?.project_name ?? "unknown";
}

// ===================================================================
// Rules source: which rules the main session follows
// (default .pi rules vs a project AGENTS.md / CLAUDE.md).
// Enforced via pi's native AGENTS.override.md slot in the project root.
// ===================================================================

const RULES_SOURCE_FILE = join(CONFIG_DIR, "rules-source.json");
const OVERRIDE_FILE = join(CWD, "AGENTS.override.md");
const RULES_SOURCES = ["pi", "agents", "claude"] as const;
type RulesSource = (typeof RULES_SOURCES)[number];

function readRulesSource(): RulesSource | null {
  try {
    const s = JSON.parse(readFileSync(RULES_SOURCE_FILE, "utf8")).source;
    return RULES_SOURCES.includes(s) ? s : null;
  } catch {
    return null;
  }
}

function writeRulesSource(source: RulesSource): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(RULES_SOURCE_FILE, `${JSON.stringify({ source }, null, 2)}\n`);
}

/** Dialog options built from what actually exists in the project root. */
function rulesOptions(): { label: string; source: RulesSource }[] {
  const opts: { label: string; source: RulesSource }[] = [
    { label: "Use current extension rules (Default)", source: "pi" },
  ];
  if (existsSync(join(CWD, "AGENTS.md")))
    opts.push({ label: "Use AGENTS.md", source: "agents" });
  if (existsSync(join(CWD, "CLAUDE.md")))
    opts.push({ label: "Use CLAUDE.md", source: "claude" });
  return opts;
}

/**
 * Materialize the chosen rules into AGENTS.override.md — pi loads it FIRST,
 * so it wins over AGENTS.md/CLAUDE.md. Returns true on success.
 */
function applyRulesSource(source: RulesSource): boolean {
  let content: string;
  if (source === "pi") {
    // Self-contained: embed the slim rules directly (same body the worrie-*
    // agent files carry). Installed workspaces have no .pi/rules copies of
    // .clinerules/system_instructions.md, so a pointer would target nothing.
    const rules = buildSubagentRules(loadWorkspaceRules()).trim();
    content = rules
      ? `# Rules Override (pi-worrie)\n\n${rules}`
      : "# Rules Override (pi-worrie)\n\nFollow the rules inside the .pi folder strictly:\n- Read `.pi/rules/.clinerules`\n- Read `.pi/rules/system_instructions.md`\n";
  } else {
    const file = source === "agents" ? "AGENTS.md" : "CLAUDE.md";
    const p = join(CWD, file);
    if (!existsSync(p)) return false;
    content = readFileSync(p, "utf8");
  }
  try {
    writeFileSync(
      OVERRIDE_FILE,
      `${content.replace(/\s+$/, "")}\n\n<!-- c: worrie -->\n`,
    );
    return true;
  } catch {
    return false;
  }
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const SHELL_TOOLS = [...READ_ONLY_TOOLS, "subagent", "subagent_wait"];

// Memory type names -> file + id prefix (null = no tracking ids)
const MEMORY_TYPES: Record<
  string,
  { file: string; prefix: string | null; title: string }
> = {
  err: { file: "error_memory.md", prefix: "ERR", title: "Errors" },
  code: { file: "codebase_map.md", prefix: "FN-FE", title: "Codebase Map" },
  impl: {
    file: "implementation_memory.md",
    prefix: "FLOW",
    title: "Implementation",
  },
  sec: { file: "security_memory.md", prefix: "SEC", title: "Security" },
  rev: { file: "review_memory.md", prefix: "REVIEW", title: "Review" },
  test: { file: "test_memory.md", prefix: "TEST", title: "Test" },
  proj: {
    file: join("..", "rules", "project_memory.md"),
    prefix: null,
    title: "Project",
  },
};

const ARCHIVE_MAP: Record<string, { file: string; archive: string }> = {
  err: { file: "error_memory.md", archive: "error_archive.md" },
  impl: {
    file: "implementation_memory.md",
    archive: "implementation_archive.md",
  },
  sec: { file: "security_memory.md", archive: "security_archive.md" },
  rev: { file: "review_memory.md", archive: "review_archive.md" },
  test: { file: "test_memory.md", archive: "test_archive.md" },
};

const PERSONAS: Record<
  string,
  {
    tools: string[];
    delegating: boolean;
    agent?: string;
    status: string;
    prompt: string;
    delegation: (task: string) => string;
  }
> = {
  ask: {
    tools: READ_ONLY_TOOLS,
    delegating: false,
    status: "[ASK] read-only",
    prompt:
      "You are the ASK persona: a read-only technical assistant. You may read, grep, find, and ls files to locate and analyze code. NEVER write, edit, or run bash. Answer with clear, structured explanations.",
    delegation: (task) => task,
  },
  plan: {
    tools: READ_ONLY_TOOLS,
    delegating: false,
    status: "[PLAN] read-only",
    prompt:
      "You are the PLAN persona: a read-only planner. You may read, grep, find, and ls files to gather context. NEVER write, edit, or run bash. Produce a structured engineering plan and WAIT for user approval before any implementation.",
    delegation: (task) => task,
  },
  coder: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-coder",
    status: "[CODER] active",
    prompt:
      "You are the CODER coordinator. Do NOT implement anything yourself in this session. Launch the worrie-coder subagent and present its concise summary to the user.",
    delegation: (task) =>
      `Launch the worrie-coder subagent with the task below. Do NOT implement anything in this session. Await the subagent result and present a concise summary: files changed, logic added, memory entries written.\n\nTask: ${task}`,
  },
  debugger: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-debugger",
    status: "[DEBUGGER] active",
    prompt:
      "You are the DEBUGGER coordinator. Do NOT debug in this session yourself. Launch the worrie-debugger subagent and present its concise summary to the user.",
    delegation: (task) =>
      `Launch the worrie-debugger subagent with the problem below. Do NOT debug in this session yourself. Await the result and present a concise summary: root cause, files changed, fix applied, memory entries written.\n\nProblem: ${task}`,
  },
  orchestrator: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-orchestrator",
    status: "[ORCH] auto-detect",
    prompt:
      "You are the ORCHESTRATOR coordinator. Launch the worrie-orchestrator subagent in AUTO-DETECT mode: it picks the right persona from the user's prompt. Present its summary.",
    delegation: (task) =>
      `Launch the worrie-orchestrator subagent in AUTO-DETECT mode. It analyzes the user prompt and chooses the matching persona (coder, debugger, reviewer, secure, tester, ask logic). Do NOT do the work in this session. Present the concise summary.\n\nPrompt: ${task}`,
  },
  "orch-full": {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-orchestrator",
    status: "[ORCH-FULL] pipeline running",
    prompt:
      "You are the ORCH-FULL coordinator. Launch the subagent tool with a CHAIN of 11 steps for the full pipeline. Present the final summary.",
    delegation: (task) =>
      `Launch the subagent tool with a CHAIN of 11 steps for this task. Each step runs as a fresh subagent - do NOT do the work in this session. Set approval: true on steps 2 through 11 (the extension will ask the user before each step). Give each step a label like "1/11: PLAN". The chain steps are:
1. worrie-planner - PLAN: produce a structured roadmap with clear steps
2. worrie-coder - CODE: implement the approved plan (use {previous})
3. worrie-tester - TEST: run typecheck, lint, unit, integration, E2E, coverage. Summarize pass/fail.
4. worrie-debugger - DEBUG: fix any failures from {previous}, explain root causes
5. worrie-secure - SECURE: OWASP scan of new code, score 0-10
6. worrie-debugger - DEBUG: catch bugs introduced by security fixes
7. worrie-tester - TEST: full pipeline again
8. worrie-coder - CLEAN: report debug traces and dead code (safe removals only)
9. worrie-reviewer - REVIEW: findings with severity
10. worrie-coder - DOCUMENT: write summary to implementation_memory.md and project_memory.md
11. ASK stage: after the chain finishes, present the final summary to the user and ask what's next.

Task: ${task}`,
  },
  reviewer: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-reviewer",
    status: "[REVIEWER] active",
    prompt:
      "You are the REVIEWER coordinator. Launch the worrie-reviewer subagent and present its findings summary to the user.",
    delegation: (task) =>
      `Launch the worrie-reviewer subagent for the review target below. Do NOT review in this session yourself. Await the result and present a concise findings summary (severity, file, recommendation).\n\nTarget: ${task}`,
  },
  secure: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-secure",
    status: "[SECURE] active",
    prompt:
      "You are the SECURE coordinator. Launch the worrie-secure subagent and present its security assessment to the user.",
    delegation: (task) =>
      `Launch the worrie-secure subagent for the security target below. Do NOT scan in this session yourself. Await the result and present a concise assessment (vulnerabilities, score 0-10, remediation).\n\nTarget: ${task}`,
  },
  tester: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-tester",
    status: "[TESTER] active",
    prompt:
      "You are the TESTER coordinator. Launch the worrie-tester subagent and present its test results to the user.",
    delegation: (task) =>
      `Launch the worrie-tester subagent for the test target below. Do NOT test in this session yourself. Await the result and present a concise summary (pipeline stages run, pass/fail, coverage).\n\nTarget: ${task}`,
  },
};

// ===================================================================
// State
// ===================================================================

let activePersona: string | null = null;
let savedTools: string[] | null = null;
let memoryConfig = { autoLog: true, promptOnBlock: true, maxEntries: 10 };

// ===================================================================
// Helpers
// ===================================================================

function pstNow(): string {
  const d = new Date();
  const date = d.toLocaleDateString("en-US", {
    timeZone: "Asia/Manila",
    month: "long",
    day: "2-digit",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `${date}, ${time} PST`;
}

function memPath(type: string): string {
  const t = MEMORY_TYPES[type];
  return t ? join(MEMORY_DIR, t.file) : "";
}

function setupDone(): boolean {
  const ws = readWorkspace();
  return !!ws?.workspace_id && ws.workspace_id !== "uninitialized";
}

// Next id for a file. Template examples hold 001, so the first real log gets 002 (REVIEW-017).
function nextTrackingId(content: string, prefix: string): string {
  // Matches 3- and 4-hash headers (codebase_map uses ####)
  const re = new RegExp(`###+ \\[${prefix}-(\\d+)\\]`, "g");
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) max = Math.max(max, parseInt(m[1], 10));
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}

function memoryEntryIds(type: string, includeResolved: boolean): string[] {
  const file = memPath(type);
  if (!file || !existsSync(file)) return [];
  const ids: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!/^#{3,4} \[/.test(line)) continue;
    const active = line.match(/^#{3,4} \[([A-Z]+(?:-[A-Z]+)*-\d+)\]/);
    if (active) {
      ids.push(active[1]);
      continue;
    }
    const resolved = line.match(
      /^#{3,4} \[RESOLVED\][^\n]*\(([A-Z]+(?:-[A-Z]+)*-\d+)\)/,
    );
    if (resolved && includeResolved) ids.push(resolved[1]);
  }
  return ids;
}

// ===================================================================
// Agent file templates (written by /setup)
// ===================================================================

// Agent file = ../skills persona + tools + protocol + WORKSPACE RULES from ../rules/.
const AGENT_SPECS: Record<
  string,
  { skill: string; tools: string; memoryProtocol?: string }
> = {
  "worrie-planner.md": {
    skill: "planner",
    tools: "read, grep, find, ls",
  },
  "worrie-coder.md": {
    skill: "coder",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol
- BAN edit rule files. State → memory only.
- § \`.clinerules\` §Memory Workflow for commands.
- Write: err→error_memory.md (ERR-NNN), code→codebase_map.md, impl→implementation_memory.md (FLOW-NNN), sec→security_memory.md (SEC-NNN), rev→review_memory.md (REVIEW-NNN), test→test_memory.md (TEST-NNN), proj→project_memory.md
- LIFO top of Section 1. ID: \`[TYPE-XXX]\` (3-digit zero-padded).
- BAN delete/truncate Section 2 (immutable history).
- On resolve → migrate SAME using \`### [RESOLVED] Title (TYPE-XXX)\`.
`,
  },
  "worrie-debugger.md": {
    skill: "debugger",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol
- BAN edit rule files. State → memory only.
- DEFAULT: log to error_memory.md (ERR-NNN).
- Active blockers → Section 1 LIFO top: \`### [ERR-NNN] Title\`
- Fixed bugs → SAME response, move to Section 2: \`### [RESOLVED] Title (ERR-NNN)\`
- When explicitly asked, may write other memory files (code, impl, sec, rev, test, proj).
- BAN delete/truncate Section 2 (immutable history).
`,
  },
  "worrie-orchestrator.md": {
    skill: "orchestrator",
    tools: "read, grep, find, ls, bash, write, edit, subagent, subagent_wait",
    memoryProtocol: `## Memory Protocol
- BAN edit rule files. State → memory only.
- Write to matching file per stage: PLAN/DOCUMENT→impl+proj, CODE→impl, TEST→test, DEBUG→err, SECURE→sec, REVIEW→rev
- LIFO top of Section 1. BAN delete existing entries.
`,
  },
  "worrie-reviewer.md": {
    skill: "reviewer",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol
- BAN edit rule files. State → memory only.
- Log findings to review_memory.md (REVIEW-NNN):
- Active → Section 1 LIFO top: \`### [REVIEW-NNN] Title\`
- Resolved → SAME response, move to Section 2: \`### [RESOLVED] Title (REVIEW-NNN)\`
- BAN delete/truncate Section 2.
`,
  },
  "worrie-secure.md": {
    skill: "secure",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol
- BAN edit rule files. State → memory only.
- Log vulnerabilities to security_memory.md (SEC-NNN):
- Active → Section 1 LIFO top: \`### [SEC-NNN] Title (SEVERITY)\`
- Patched → SAME response, move to Section 2: \`### [RESOLVED] Title (SEC-NNN)\` + update Overall Security Score
- BAN delete/truncate Section 2.
`,
  },
  "worrie-tester.md": {
    skill: "tester",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol
- BAN edit rule files. State → memory only.
- Log strategies to test_memory.md (TEST-NNN):
- Active → Section 1 LIFO top: \`### [TEST-NNN] Title\`
- Resolved → SAME response, move to Section 2: \`### [RESOLVED] Title (TEST-NNN)\`
- BAN delete/truncate Section 2.
`,
  },
};

// ===================================================================
// Agent file construction: persona (../skills) + protocol + WORKSPACE RULES
// ===================================================================

/** Directory of this extension file (works under jiti CJS and ESM loading). */
function extensionDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return __dirname;
  }
}

const PKG_ROOT = join(extensionDir(), "..");

/** Full workspace rules text, identical to .pi/rules (two files, joined). */
function loadWorkspaceRules(): string {
  try {
    const cli = readFileSync(join(PKG_ROOT, "rules", ".clinerules"), "utf8");
    const sys = readFileSync(
      join(PKG_ROOT, "rules", "system_instructions.md"),
      "utf8",
    );
    return `${cli}\n\n---\n\n${sys}`;
  } catch {
    return "";
  }
}

// H2 sections from the full rules that a subagent actually needs at execution time.
// Everything else (persona matrix, delegation, flag protocols, init/archive/clean) is
// main-session meta-work handled by the extension commands + the parent session.
const SUBAGENT_RULES_SECTIONS = [
  "System Boundaries",
  "Strict Rule Modification Constraints",
  "MANDATORY TIMESTAMP COMPUTATION RULE",
  "NEWEST-ON-TOP SORTING ENFORCEMENT",
  "BEGINNER-FRIENDLY HIGH-DETAIL CLARITY MANDATE",
  "IMMUTABLE SECTION TITLE AND LOG PROTECTION",
  "CRITICAL DATA RETENTION & HISTORICAL PRESERVATION",
  "IMMEDIATE RESOLUTION MANDATE",
];

/** Slice out only the subagent-relevant H2 sections from the full rules text. */
function buildSubagentRules(full: string): string {
  const lines = full.split("\n");
  const isH2 = new Array(lines.length).fill(false);
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("```")) fence = !fence;
    if (!fence && /^##\s+\S/.test(t)) isH2[i] = true;
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isH2[i] || !SUBAGENT_RULES_SECTIONS.some((p) => lines[i].includes(p)))
      continue;
    let j = i + 1;
    while (j < lines.length && !isH2[j]) j++;
    out.push(lines.slice(i, j).join("\n").trim());
    i = j - 1;
  }
  return out.join("\n\n");
}

const RULES_START = "## WORKSPACE RULES (pi-worrie -- immutable)";
const RULES_END = "<!-- c: worrie -->"; // end boundary = sole credit marker; never emitted inside the block

function rulesBlock(rulesText: string): string {
  return `${RULES_START}\n\n${rulesText}`;
}

// Agent file = skill persona + tools + memory protocol + slim workspace rules.
function buildAgentFile(
  spec: { skill: string; tools: string; memoryProtocol?: string },
  rulesText: string,
  agentName: string,
): string {
  const skillPath = join(PKG_ROOT, "skills", spec.skill, "SKILL.md");
  let skill = readFileSync(skillPath, "utf8");
  // The skill's own trailing marker moves to the very end of the generated file.
  skill = skill.replace(/\s*<!--\s*c: worrie\s*-->\s*$/, "");
  if (skill.startsWith("---")) {
    const end = skill.indexOf("\n---", 3);
    if (end > 0) {
      // Rename to the worrie-* agent identity — subagents.ts discovers by
      // frontmatter name, and persona commands launch worrie-* agents.
      const head = /\nname:[^\n]*/.test(skill.slice(0, end))
        ? skill.slice(0, end).replace(/\nname:[^\n]*/, `\nname: ${agentName}`)
        : `${skill.slice(0, end)}\nname: ${agentName}`;
      skill =
        head +
        `\ntools: ${spec.tools}\nsystemPromptMode: replace\ninheritProjectContext: true` +
        skill.slice(end);
    }
  }
  const extra = spec.memoryProtocol ? spec.memoryProtocol + "\n" : "";
  return (
    skill +
    (extra ? `\n\n${extra}` : "") +
    "\n\n" +
    rulesBlock(rulesText) +
    "\n\n<!-- c: worrie -->\n"
  );
}

/** Refresh the rules section in an existing agent file; returns true if changed. */
function refreshRulesSection(filePath: string, rulesText: string): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const block = rulesBlock(rulesText);
  const sIdx = content.indexOf(RULES_START);
  const eIdx = content.lastIndexOf(RULES_END);
  let next: string;
  if (sIdx >= 0 && eIdx > sIdx) {
    const head = content.slice(0, sIdx).replace(/\s+$/, "");
    const tail = content.slice(eIdx).replace(/^\s+/, "");
    next = tail ? `${head}\n\n${block}\n\n${tail}` : `${head}\n\n${block}\n`;
  } else if (sIdx >= 0) {
    next =
      content.slice(0, sIdx).replace(/\s+$/, "") +
      "\n\n" +
      block +
      "\n\n" +
      RULES_END +
      "\n";
  } else {
    next =
      content.replace(/\s+$/, "") + "\n\n" + block + "\n\n" + RULES_END + "\n";
  }
  if (next === content) return false;
  writeFileSync(filePath, next);
  return true;
}

// ===================================================================
// Memory file templates (written by /setup when missing)
// ===================================================================

function loadMemoryTemplate(file: string): string {
  try {
    return readFileSync(join(PKG_ROOT, "templates", "memory", file), "utf8");
  } catch {
    return "";
  }
}

function loadArchiveTemplate(file: string): string {
  try {
    return readFileSync(join(PKG_ROOT, "templates", "archives", file), "utf8");
  } catch {
    return "";
  }
}

function loadProjectMemoryTemplate(): string {
  try {
    return readFileSync(
      join(PKG_ROOT, "templates", "rules", "project_memory.md"),
      "utf8",
    );
  } catch {
    return "";
  }
}

const MEMORY_TEMPLATES: Record<string, string> = {
  "error_memory.md": loadMemoryTemplate("error_memory.md"),
  "implementation_memory.md": loadMemoryTemplate("implementation_memory.md"),
  "security_memory.md": loadMemoryTemplate("security_memory.md"),
  "review_memory.md": loadMemoryTemplate("review_memory.md"),
  "test_memory.md": loadMemoryTemplate("test_memory.md"),
  "codebase_map.md": loadMemoryTemplate("codebase_map.md"),
};

const ARCHIVE_TEMPLATES: Record<string, string> = {
  "error_archive.md": loadArchiveTemplate("error_archive.md"),
  "implementation_archive.md": loadArchiveTemplate("implementation_archive.md"),
  "review_archive.md": loadArchiveTemplate("review_archive.md"),
  "security_archive.md": loadArchiveTemplate("security_archive.md"),
  "test_archive.md": loadArchiveTemplate("test_archive.md"),
};

const PROJECT_MEMORY_TEMPLATE = loadProjectMemoryTemplate();
function logMemory(ctx: any, type: string, message: string): void {
  const file = memPath(type);
  if (!file || !existsSync(file)) {
    ctx.ui.notify(
      `Memory file for "${type}" missing. Run /setup first.`,
      "warning",
    );
    return;
  }
  const t = MEMORY_TYPES[type];
  const content = readFileSync(file, "utf8");
  const id = t.prefix ? nextTrackingId(content, t.prefix) : null;
  const title = message.split("\n")[0].slice(0, 80);
  const entry = buildMemoryEntry(type, id, title, message);
  let sec1 = content.indexOf("## 1.");
  let insertAt =
    sec1 === -1 ? content.length : sec1 + content.slice(sec1).indexOf("\n") + 1;
  if (type === "code") {
    const layer = content.indexOf("### 1A. Logic, Functions & Code Structures");
    if (layer >= 0) insertAt = layer + content.slice(layer).indexOf("\n") + 1;
  }
  writeFileSync(
    file,
    content.slice(0, insertAt) + "\n" + entry + content.slice(insertAt),
  );
  ctx.ui.notify(`Logged ${id ?? type} to ${t.file}`, "info");
}

// Memory entry with the exact fields from the user workflow templates.
function buildMemoryEntry(
  type: string,
  id: string | null,
  title: string,
  message: string,
): string {
  const msg = message.replace(/\n/g, "\n  ");
  const now = pstNow();
  switch (type) {
    case "err":
      return `### [${id}] ${title}\n\n- **Symptom**: ${msg}\n- **Context/Trigger**: _What command, file, or action caused this error?_\n- **Suspected Root Cause**: _Initial assessment of why this is happening._\n\n`;
    case "impl":
      return `### [${id}] ${title}\n\n- **Context/Objective**: ${msg}\n- **Step-by-Step Logic Outline**:\n  1. [Step 1 description]\n  2. [Step 2 description]\n- **Dependencies Involved**: [List files, databases, or modules impacted by this flow]\n- **Status**: IN_PROGRESS\n- **Logged At**: ${now}\n\n`;
    case "sec":
      return `### [${id}] ${title} (SEVERITY)\n\n- **Vulnerability Rating**: [Score 0 - 10]\n- **Severity Level**: CRITICAL | HIGH | MEDIUM | LOW\n- **Attacker Exploit Methodology**: ${msg}\n- **Production-Ready Remediation Plan**: [Step-by-step fix outline]\n- **Status**: OPEN\n- **Logged At**: ${now}\n\n`;
    case "rev":
      return `### [${id}] ${title}\n\n- **File/Path**: _path/to/file.ext:line_number_\n- **Severity**: CRITICAL | HIGH | MEDIUM | LOW\n- **Category**: Security | Performance | Maintainability | Correctness | Testability\n- **Finding**: ${msg}\n- **Recommendation**: [Specific remediation steps or code suggestion]\n- **Status**: OPEN\n- **Reviewed At**: ${now}\n\n`;
    case "code":
      return `#### [${id}] ${title}\n\n- **Purpose**: ${msg}\n- **Location**: _file path where defined_\n- **Input/Output**: _parameters and return values_\n- **Dependencies**: _what other functions/files does it rely on?_\n- **Called By**: _which components or functions invoke this?_\n- **Side Effects**: _any state mutations, API calls, or storage operations_\n\n`;
    case "test":
      return `### [${id}] ${title}\n\n- **File/Path**: _path/to/test_file.ext_\n- **Type**: Unit | Integration | E2E | Performance\n- **Preconditions**: [Required setup or state before test execution]\n- **Test Input**: [Specific data or mock state required]\n- **Expected Output**: [Exact expected result or behavior]\n- **Assertions**: [Specific assertions to validate]\n- **Framework**: Vitest | Playwright\n- **Coverage Target**: [0-100%]\n- **Coverage Status**: COVERED | UNCOVERED | PARTIAL\n- **Logged At**: ${now}\n\n`;
    default:
      return `### [${id ?? "NOTE"}] ${title}\n\n- **Context**: ${msg}\n- **Logged At**: ${now}\n\n`;
  }
}

function showMemory(ctx: any, type: string, opt: string): void {
  const t = MEMORY_TYPES[type];
  const file = memPath(type);
  if (!file || !existsSync(file)) {
    ctx.ui.notify(
      `Memory file for "${type}" missing. Run /setup first.`,
      "warning",
    );
    return;
  }
  const content = readFileSync(file, "utf8");
  const raw = content
    .split("\n###")
    .slice(1)
    .map((b) => "###" + b);
  const blocks = raw.filter((b) => /^#{3,4} \[/.test(b));
  const entries = blocks.filter((b) =>
    /^#{3,4} \[(RESOLVED\] |[A-Z]+(?:-[A-Z]+)*-\d+\])/.test(b),
  );
  let list = entries;
  if (opt === "--open")
    list = entries.filter((b) => !b.startsWith("### [RESOLVED]"));
  else if (opt === "--resolved")
    list = entries.filter((b) => b.startsWith("### [RESOLVED]"));
  else if (opt === "--all") list = entries;
  else if (/^\d+$/.test(opt)) list = entries.slice(0, parseInt(opt, 10));
  else if (opt && !opt.startsWith("--")) {
    const id = opt.toUpperCase();
    list = entries.filter((b) => b.includes(`[${id}]`));
  } else list = entries.slice(0, 5);
  if (list.length === 0) {
    ctx.ui.notify("No entries found.", "info");
    return;
  }
  const out = list
    .map((b) => {
      const head = b.split("\n")[0];
      const status = b.startsWith("### [RESOLVED]") ? "RESOLVED" : "OPEN";
      return `${head.replace(/^### /, "")}  ${status}`;
    })
    .join("\n");
  ctx.ui.notify(`${t.title ?? type} (${list.length} shown):\n${out}`, "info");
}

// ── New /m workflow helpers ──

/** Resolve entry by ID across all memory files (AI-free). */
function resolveEntry(ctx: any, id: string): void {
  const idUpper = id.toUpperCase();
  let found = false;
  for (const [type, t] of Object.entries(MEMORY_TYPES)) {
    if (!t.prefix) continue;
    const file = memPath(type);
    if (!file || !existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    // Find in Section 1 (active)
    const start = lines.findIndex((l) => l.startsWith(`### [${idUpper}] `));
    if (start === -1) continue;
    // Check it's in Section 1, not Section 2
    const sec1End = lines.findIndex((l, i) => i > start && l.startsWith("## 2."));
    if (sec1End === -1) continue; // not in Section 1
    // Find end of this entry block
    let end = lines.findIndex((l, i) => i > start && /^#{3,4} \[/.test(l));
    if (end === -1) {
      end = sec1End;
    }
    const block = lines.slice(start, end);
    const title = block[0].replace(`### [${idUpper}] `, "");
    block[0] = `### [RESOLVED] ${title} (${idUpper})`;
    // Move to Section 2
    let sec2 = lines.findIndex((l, i) => i > start && l.startsWith("## 2."));
    if (sec2 === -1) sec2 = sec1End;
    let ins = sec2 + 1;
    while (ins < lines.length && (lines[ins].trim() === "" || lines[ins].startsWith("_") || lines[ins].startsWith(">"))) ins++;
    lines.splice(start, end - start);
    lines.splice(ins, 0, ...block, "");
    writeFileSync(file, lines.join("\n"));
    ctx.ui.notify(`Resolved ${idUpper} → Section 2 (${t.file})`, "info");
    found = true;
    break;
  }
  if (!found) ctx.ui.notify(`Entry ${idUpper} not found in active section.`, "warning");
}

/** Build table for a single memory file. */
function buildTable(ctx: any, type: string, flag: string): void {
  const t = MEMORY_TYPES[type];
  const file = memPath(type);
  if (!file || !existsSync(file)) {
    ctx.ui.notify(`Memory file for "${type}" missing. Run /setup first.`, "warning");
    return;
  }
  const content = readFileSync(file, "utf8");
  const raw = content.split("\n###").slice(1).map((b) => "###" + b);
  const blocks = raw.filter((b) => /^#{3,4} \[/.test(b));
  const entries = blocks.filter((b) => /^#{3,4} \[(RESOLVED\] |[A-Z]+(?:-[A-Z]+)*-\d+)\]/.test(b));
  let list = entries;
  if (flag === "--active") list = entries.filter((b) => !b.startsWith("### [RESOLVED]"));
  else if (flag === "--resolved") list = entries.filter((b) => b.startsWith("### [RESOLVED]"));
  else if (flag === "--all") list = entries;
  else if (flag === "--count") {
    const active = entries.filter((b) => !b.startsWith("### [RESOLVED]")).length;
    const resolved = entries.filter((b) => b.startsWith("### [RESOLVED]")).length;
    ctx.ui.notify(`${type}: open ${active}  resolved ${resolved}  total ${active + resolved}`, "info");
    return;
  }
  if (list.length === 0) {
    ctx.ui.notify(`No entries for ${type}.`, "info");
    return;
  }
  // Format as table
  const rows = list.map((b) => {
    const head = b.split("\n")[0];
    const status = b.startsWith("### [RESOLVED]") ? "RESOLVED" : "OPEN";
    // Extract ID and title
    const match = head.match(/^### \[([^\]]+)\] (.+)/);
    const id = match ? `[${match[1]}]` : head.slice(0, 12).padEnd(12);
    const title = match ? match[2].slice(0, 40).padEnd(40) : head.slice(12).padEnd(40);
    return `| ${id} | ${title} | ${status} |`;
  });
  const header = `| ID | Title | Status |\n|----|-------|--------|`;
  ctx.ui.notify(`/ml ${type} (${list.length} entries)\n${header}\n${rows.join("\n")}`, "info");
}

/** Build cross-file table overview. */
function buildCrossFileTable(ctx: any, flag: string): void {
  const allEntries: Array<{ file: string; id: string; title: string; status: string }> = [];
  for (const [type, t] of Object.entries(MEMORY_TYPES)) {
    if (!t.prefix) continue;
    const file = memPath(type);
    if (!file || !existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const raw = content.split("\n###").slice(1).map((b) => "###" + b);
    const blocks = raw.filter((b) => /^#{3,4} \[/.test(b));
    const entries = blocks.filter((b) => /^#{3,4} \[(RESOLVED\] |[A-Z]+(?:-[A-Z]+)*-\d+)\]/.test(b));
    let list = entries;
    if (flag === "--active") list = entries.filter((b) => !b.startsWith("### [RESOLVED]"));
    else if (flag === "--resolved") list = entries.filter((b) => b.startsWith("### [RESOLVED]"));
    else if (flag === "--count") {
      const active = entries.filter((b) => !b.startsWith("### [RESOLVED]")).length;
      const resolved = entries.filter((b) => b.startsWith("### [RESOLVED]")).length;
      ctx.ui.notify(`${t.file}: open ${active}  resolved ${resolved}`, "info");
      continue;
    }
    for (const b of list) {
      const head = b.split("\n")[0];
      const status = b.startsWith("### [RESOLVED]") ? "RESOLVED" : "OPEN";
      const match = head.match(/^#{3,4} \[([^\]]+)\] (.+)/);
      if (match) {
        allEntries.push({
          file: t.file,
          id: `[${match[1]}]`,
          title: match[2].slice(0, 35),
          status,
        });
      }
    }
  }
  if (allEntries.length === 0) {
    ctx.ui.notify("No entries found.", "info");
    return;
  }
  // Format as table (max 20 rows)
  const rows = allEntries.slice(0, 20).map((e) =>
    `| ${e.file.padEnd(20)} | ${e.id.padEnd(10)} | ${e.title.padEnd(35)} | ${e.status} |`,
  );
  const header = `| File | ID | Title | Status |\n|------|----|-------|--------|`;
  const extra = allEntries.length > 20 ? `\n... and ${allEntries.length - 20} more` : "";
  ctx.ui.notify(`/mlist (${flag}) ${allEntries.length} entries total${extra}\n${header}\n${rows.join("\n")}`, "info");
}

function resolveMemory(ctx: any, type: string, id: string): void {
  const file = memPath(type);
  if (!file || !existsSync(file)) {
    ctx.ui.notify(`Memory file for "${type}" missing.`, "warning");
    return;
  }
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`### [${id}] `));
  if (start === -1) {
    ctx.ui.notify(`Entry ${id} not found in active section.`, "warning");
    return;
  }

  // impl files have NO Section 2 (workflow format): resolve in place via Status
  if (type === "impl") {
    let done = false;
    const end = (() => {
      const n = lines.findIndex((l, i) => i > start && l.startsWith("### ["));
      return n === -1 ? lines.length : n;
    })();
    for (let i = start; i < end; i++) {
      if (lines[i].startsWith("- **Status**: ")) {
        lines[i] = "- **Status**: COMPLETED";
        done = true;
        break;
      }
    }
    if (!done) {
      ctx.ui.notify(`Entry ${id} has no Status field to update.`, "warning");
      return;
    }
    writeFileSync(file, lines.join("\n"));
    ctx.ui.notify(
      `Resolved ${id}: Status -> COMPLETED (impl entries stay in Section 1 per workflow format).`,
      "info",
    );
    return;
  }
  if (type === "code" || type === "proj") {
    ctx.ui.notify(
      `${type} entries follow the workflow structure and are not moved to Section 2.`,
      "info",
    );
    return;
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith("### ["));
  if (end === -1) {
    // no more entries after this one: cap the block at Section 2 header
    const s2 = lines.findIndex((l, i) => i > start && l.startsWith("## 2."));
    end = s2 === -1 ? lines.length : s2;
  }
  const block = lines.slice(start, end);
  lines.splice(start, end - start);
  const title = block[0].replace(`### [${id}] `, "");
  block[0] = `### [RESOLVED] ${title} (${id})`;
  let sec2 = lines.findIndex((l) => l.startsWith("## 2."));
  if (sec2 === -1) {
    ctx.ui.notify("Section 2 header not found in file.", "warning");
    return;
  }
  let ins = sec2 + 1;
  while (
    ins < lines.length &&
    (lines[ins].trim() === "" ||
      lines[ins].startsWith("_") ||
      lines[ins].startsWith(">"))
  )
    ins++;
  lines.splice(ins, 0, ...block, "");
  writeFileSync(file, lines.join("\n"));
  ctx.ui.notify(
    `Resolved ${id}. Moved to Section 2 as [RESOLVED] ${title} (${id})`,
    "info",
  );
}

function editMemory(
  ctx: any,
  type: string,
  id: string,
  field: string,
  value: string,
): void {
  const file = memPath(type);
  if (!file || !existsSync(file)) {
    ctx.ui.notify(`Memory file for "${type}" missing.`, "warning");
    return;
  }
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const start = lines.findIndex(
    (l) =>
      (/^#{3,4} \[/.test(l) && l.includes(`[${id}]`)) ||
      (/^#{3,4} \[RESOLVED\]/.test(l) && l.includes(`(${id})`)),
  );
  if (start === -1) {
    ctx.ui.notify(`Entry ${id} not found.`, "warning");
    return;
  }
  let end = lines.findIndex((l, i) => i > start && /^#{3,4} \[/.test(l));
  if (end === -1) {
    const s2 = lines.findIndex((l, i) => i > start && l.startsWith("## 2."));
    end = s2 === -1 ? lines.length : s2;
  }
  const block = lines.slice(start, end);
  const fieldLine = block.findIndex((l) => l.startsWith(`- **${field}**:`));
  if (fieldLine !== -1) block[fieldLine] = `- **${field}**: ${value}`;
  else block.splice(block.length - 1, 0, `- **${field}**: ${value}`);
  lines.splice(start, end - start, ...block);
  writeFileSync(file, lines.join("\n"));
  ctx.ui.notify(`Updated ${id}: ${field} = ${value}`, "info");
}

function searchMemory(ctx: any, type: string, query: string): void {
  const file = memPath(type);
  if (!file || !existsSync(file)) {
    ctx.ui.notify(`Memory file for "${type}" missing.`, "warning");
    return;
  }
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const hits = lines
    .map((l, i) => ({ l, i: i + 1 }))
    .filter(
      ({ l }) =>
        l.toLowerCase().includes(query.toLowerCase()) && l.trim() !== "",
    );
  if (hits.length === 0) {
    ctx.ui.notify(
      `No matches for "${query}" in ${MEMORY_TYPES[type].file}`,
      "info",
    );
    return;
  }
  const out = hits
    .slice(0, 20)
    .map(({ l, i }) => `line ${i}: ${l.trim().slice(0, 90)}`)
    .join("\n");
  ctx.ui.notify(
    `${hits.length} match(es) in ${MEMORY_TYPES[type].file}:\n${out}`,
    "info",
  );
}

function archiveMemory(ctx: any): void {
  let moved = 0;
  for (const key of Object.keys(ARCHIVE_MAP)) {
    const { file, archive } = ARCHIVE_MAP[key];
    const src = join(MEMORY_DIR, file);
    const dst = join(ARCHIVES_DIR, archive);
    if (!existsSync(src) || !existsSync(dst)) continue;
    const content = readFileSync(src, "utf8");
    const lines = content.split("\n");
    const sec1 = lines.findIndex((l) => l.startsWith("## 1."));
    const sec2 = lines.findIndex((l, i) => i > sec1 && l.startsWith("## 2."));
    if (sec1 === -1 || sec2 === -1) continue;
    const section = lines.slice(sec1 + 1, sec2);
    const starts = section
      .map((l, i) => ({ l, i: i + sec1 + 1 }))
      .filter(({ l }) => l.startsWith("### ["));
    if (starts.length <= memoryConfig.maxEntries) continue;
    const overflow = starts.length - memoryConfig.maxEntries;
    // oldest = bottom of section 1
    // keep the newest maxEntries, archive everything below them
    const cutIdx = starts[memoryConfig.maxEntries].i;
    const archived = lines.slice(cutIdx, sec2);
    lines.splice(cutIdx, sec2 - cutIdx);
    const archiveContent = readFileSync(dst, "utf8");
    const insertAt = archiveContent.lastIndexOf("## Archived Entries");
    const withEntries =
      archiveContent.slice(0, insertAt) +
      archiveContent
        .slice(insertAt)
        .replace(
          "## Archived Entries",
          "## Archived Entries\n" + archived.join("\n"),
        );
    const totalMatch = archiveContent.match(
      /- \*\*Total Entries Archived\*\*: (\d+)/,
    );
    const total = totalMatch
      ? parseInt(totalMatch[1], 10) + overflow
      : overflow;
    writeFileSync(
      dst,
      withEntries
        .replace(
          /- \*\*Last Archived At\*\*: .+/,
          `- **Last Archived At**: ${pstNow()}`,
        )
        .replace(
          /- \*\*Total Entries Archived\*\*: \d+/,
          `- **Total Entries Archived**: ${total}`,
        )
        .replace(/\(No entries archived yet\)\n?/, ""),
    );
    writeFileSync(src, lines.join("\n"));
    moved += overflow;
    ctx.ui.notify(
      `[ARCHIVAL] Moved ${overflow} entries from ${file} to ${archive}`,
      "info",
    );
  }
  if (moved === 0)
    ctx.ui.notify("Nothing to archive - all sections within limit.", "info");
}

function showConfig(ctx: any): void {
  ctx.ui.notify(
    `[MEM] auto-log ${memoryConfig.autoLog ? "ON" : "OFF"}\n[BLOCK] prompt ${memoryConfig.promptOnBlock ? "ON" : "OFF"}\n[ARCHIVE] threshold ${memoryConfig.maxEntries}`,
    "info",
  );
}

// ===================================================================
// /clean scan
// ===================================================================

const DEBUG_PATTERNS = [
  /console\.(log|error|warn|debug|info)\(/,
  /\bdebugger\b/,
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bHACK\b/,
];
const JUNK_EXTS = [".bak", ".tmp", ".log"];
const TEXT_EXTS = [
  ".ts",
  ".js",
  ".tsx",
  ".jsx",
  ".md",
  ".json",
  ".py",
  ".css",
  ".html",
  ".vue",
  ".rs",
  ".go",
];
const SKIP_DIRS = new Set([".git", "node_modules", ".pi", ".agents"]);

interface ScanResult {
  junk: string[];
  traces: { file: string; line: number; text: string }[];
  empty: string[];
}

function scanForArtifacts(dir: string, result: ScanResult): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) scanForArtifacts(full, result);
      continue;
    }
    if (st.size === 0 && !entry.endsWith(".gitignore")) {
      result.empty.push(full);
      continue;
    }
    const ext = extname(entry).toLowerCase();
    if (JUNK_EXTS.includes(ext)) {
      result.junk.push(full);
      continue;
    }
    if (TEXT_EXTS.includes(ext) && st.size < 1_000_000) {
      try {
        const lines = readFileSync(full, "utf8").split("\n");
        lines.forEach((l, i) => {
          if (DEBUG_PATTERNS.some((re) => re.test(l))) {
            result.traces.push({
              file: full,
              line: i + 1,
              text: l.trim().slice(0, 90),
            });
          }
        });
      } catch {
        // binary or unreadable, skip
      }
    }
  }
}

// ===================================================================
// Extension
// ===================================================================

export default function (pi: ExtensionAPI) {
  // ── session start: restore state, status lines ──
  pi.on("session_start", async (_event, ctx) => {
    memoryConfig = { autoLog: true, promptOnBlock: true, maxEntries: 10 };
    activePersona = null;
    try {
      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type === "custom" && entry.customType === "worrie-persona") {
          const data = entry.data as { persona: string } | undefined;
          if (data?.persona && PERSONAS[data.persona])
            activePersona = data.persona;
        }
        if (
          entry.type === "custom" &&
          entry.customType === "worrie-memory-config"
        ) {
          const data = entry.data as Partial<typeof memoryConfig> | undefined;
          if (data) memoryConfig = { ...memoryConfig, ...data };
        }
      }
    } catch {
      // ephemeral session
    }
    // restore the rules override if a source was chosen before
    const saved = readRulesSource();
    if (saved) applyRulesSource(saved);
    if (!setupDone()) {
      ctx.ui.setStatus("worrie-setup", "[SETUP] not initialized");
    }
    ctx.ui.setStatus(
      "worrie-memory",
      `[MEM] auto-log ${memoryConfig.autoLog ? "ON" : "OFF"}`,
    );
    if (activePersona) {
      const p = PERSONAS[activePersona];
      ctx.ui.setStatus("worrie-persona", p.status);
      savedTools = pi.getActiveTools();
      pi.setActiveTools(p.tools);
    } else {
      ctx.ui.setStatus("worrie-persona", "[NORMAL]");
    }
  });

  // ── /setup ──
  pi.registerCommand("setup", {
    description:
      "Initialize workspace: workspace.json, memory files, agent files",
    handler: async (_args, ctx) => {
      mkdirSync(MEMORY_DIR, { recursive: true });
      mkdirSync(AGENTS_DIR, { recursive: true });
      mkdirSync(ARCHIVES_DIR, { recursive: true });

      // workspace.json
      if (!setupDone()) {
        const name = await ctx.ui.input("Enter project name:", "");
        if (!name) {
          ctx.ui.notify("Setup cancelled.", "warning");
          return;
        }
        const slug = name
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        writeFileSync(
          WORKSPACE_FILE,
          JSON.stringify(
            {
              workspace_id: slug,
              project_name: name,
              initialized_at: pstNow(),
              initialized_by: "pi-worrie",
            },
            null,
            2,
          ) + "\n// c: worrie\n",
        );
        ctx.ui.notify(`WORKSPACE INITIALIZED: ${name} | ID: ${slug}`, "info");
      } else {
        const name = readWorkspaceName();
        ctx.ui.notify(`WORKSPACE ALREADY INITIALIZED: ${name}`, "info");
      }

      // memory files (never overwrite existing)
      let created = 0;
      for (const [file, template] of Object.entries(MEMORY_TEMPLATES)) {
        const path = join(MEMORY_DIR, file);
        if (!existsSync(path)) {
          writeFileSync(path, template);
          created++;
        }
      }
      const projPath = join(CONFIG_DIR, "rules", "project_memory.md");
      if (!existsSync(projPath)) {
        mkdirSync(dirname(projPath), { recursive: true });
        writeFileSync(projPath, PROJECT_MEMORY_TEMPLATE);
        created++;
      }

      // archive files
      for (const [file, template] of Object.entries(ARCHIVE_TEMPLATES)) {
        const path = join(ARCHIVES_DIR, file);
        if (!existsSync(path)) {
          writeFileSync(path, template);
          created++;
        }
      }

      // agent files: create missing; refresh the WORKSPACE RULES section on re-run (persona kept)
      const rulesText = buildSubagentRules(loadWorkspaceRules());
      let agents = 0;
      for (const [file, spec] of Object.entries(AGENT_SPECS)) {
        const agentPath = join(AGENTS_DIR, file);
        if (!existsSync(agentPath)) {
          writeFileSync(
            agentPath,
            buildAgentFile(spec as any, rulesText, file.replace(/\.md$/, "")),
          );
          agents++;
        } else if (rulesText && refreshRulesSection(agentPath, rulesText)) {
          agents++;
        }
      }

      // rules source: ask ONCE when a conflicting AGENTS.md/CLAUDE.md exists;
      // afterwards only /rules reopens the dialog
      if (!readRulesSource()) {
        const opts = rulesOptions();
        if (opts.length > 1) {
          const picked = await ctx.ui.select(
            "Which rules should this workspace follow?",
            opts.map((o) => o.label),
          );
          const chosen = opts.find((o) => o.label === picked);
          if (chosen) {
            writeRulesSource(chosen.source);
            applyRulesSource(chosen.source);
          }
        }
      }

      ctx.ui.setStatus("worrie-setup", undefined);
      ctx.ui.setStatus("worrie-persona", "[NORMAL]");
      ctx.ui.notify(
        `Setup complete. ${agents} agent file(s) created, ${created} memory/archive file(s) created. Personas ready: /ask /plan /coder /debugger /orchestrator /orch-full /reviewer /secure /tester`,
        "info",
      );
    },
  });

  // ── persona commands ──
  for (const [name, p] of Object.entries(PERSONAS)) {
    pi.registerCommand(name, {
      description: p.delegating
        ? `${name} persona - delegates to ${p.agent} subagent`
        : `${name} persona - read-only, runs in this session`,
      handler: async (args, ctx) => {
        if (!setupDone()) {
          ctx.ui.notify(
            "Run /setup first to initialize the workspace.",
            "warning",
          );
          return;
        }
        if (!savedTools) savedTools = pi.getActiveTools();
        activePersona = name;
        pi.setActiveTools(p.tools);
        ctx.ui.setStatus("worrie-persona", p.status);
        if (p.delegating && p.agent) {
          ctx.ui.setStatus(
            "worrie-subagent",
            `[SUBAGENT] ${p.agent} working...`,
          );
        }
        pi.appendEntry("worrie-persona", { persona: name, at: Date.now() });
        const task = (args ?? "").trim();
        pi.sendUserMessage(p.delegation(task));
      },
    });
  }

  // ── /normal ──
  pi.registerCommand("normal", {
    description: "Exit persona mode, restore all tools",
    handler: async (_args, ctx) => {
      activePersona = null;
      if (savedTools) {
        pi.setActiveTools(savedTools);
        savedTools = null;
      }
      ctx.ui.setStatus("worrie-persona", "[NORMAL]");
      ctx.ui.setStatus("worrie-subagent", undefined);
      ctx.ui.setStatus("worrie-stage", undefined);
      ctx.ui.notify("Persona mode off. All tools restored.", "info");
    },
  });

  // ── /m <type> "msg" — create entry ──
  pi.registerCommand("m", {
    description: "Memory: log, resolve, view, list",
    getArgumentCompletions: (prefix: string) => {
      const text = prefix ?? "";
      const parts = text.split(/\s+/);
      const isAtEnd = text.endsWith(" ");
      const done = isAtEnd ? parts.filter(Boolean) : parts.slice(0, -1);
      const current = isAtEnd ? "" : parts[parts.length - 1];

      const filter = (
        items: { value: string; label: string; description?: string }[],
        tok: string,
      ) => {
        const f = items.filter((i) => i.value.startsWith(tok));
        return f.length > 0 ? f : null;
      };

      const types = Object.entries(MEMORY_TYPES).map(([key, t]) => ({
        value: key,
        label: key,
        description: `${t.title} -> .pi/${t.file}`,
      }));

      if (done.length === 0) return filter([{ value: "r", label: "r", description: "Resolve entry by ID" }], current);
      if (done[0] === "r") {
        const ids = memoryEntryIds(Object.keys(MEMORY_TYPES)[0], false).slice(0, 20);
        return filter(ids.map((id) => ({ value: id, label: id, description: `Entry ${id}` })), current);
      }
      const type = done[0];
      if (!MEMORY_TYPES[type]) return filter([{ value: "r", label: "r", description: "Resolve entry by ID" }], current);
      return null;
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const cmd = parts[0];
      const rest = parts.slice(1);

      if (cmd === "r") {
        // /m r <id> — resolve entry manually (AI-free)
        const id = (rest[0] ?? "").toUpperCase();
        if (!id) {
          ctx.ui.notify("Usage: /m r <ERR-XXX | SEC-XXX | REV-XXX | TEST-XXX>", "warning");
          return;
        }
        resolveEntry(ctx, id);
        return;
      }

      // /m <type> "message" — log entry
      const type = cmd;
      let message = rest.join(" ").replace(/^"/, "").replace(/"$/, "").trim();
      if (!MEMORY_TYPES[type] || !message) {
        ctx.ui.notify('Usage: /m <err|sec|rev|test|impl|code|proj> "message"', "warning");
        return;
      }
      logMemory(ctx, type, message);
    },
  });

  // ── /ml <type> [--active|--resolved|--all|--count] ──
  pi.registerCommand("ml", {
    description: "View memory entries as table",
    getArgumentCompletions: (prefix: string) => {
      const text = prefix ?? "";
      const parts = text.split(/\s+/);
      const isAtEnd = text.endsWith(" ");
      const done = isAtEnd ? parts.filter(Boolean) : parts.slice(0, -1);
      const current = isAtEnd ? "" : parts[parts.length - 1];

      const filter = (
        items: { value: string; label: string; description?: string }[],
        tok: string,
      ) => items.filter((i) => i.value.startsWith(tok));

      const types = Object.entries(MEMORY_TYPES).map(([key, t]) => ({
        value: key,
        label: key,
        description: `${t.title} -> .pi/${t.file}`,
      }));

      if (done.length === 0) return filter(types, current);
      const type = done[0];
      if (!MEMORY_TYPES[type]) return null;
      const flags = ["--active", "--resolved", "--all", "--count"];
      if (done.length === 1) return filter(flags.map((f) => ({ value: f, label: f, description: f })), current);
      return null;
    },
    handler: (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const type = parts[0];
      const flag = parts[1] ?? "--active";
      if (!MEMORY_TYPES[type]) {
        ctx.ui.notify("Usage: /ml <err|sec|rev|test|impl|code|proj> [--active|--resolved|--all|--count]", "warning");
        return;
      }
      buildTable(ctx, type, flag);
    },
  });

  // ── /mlist [--active|--resolved|--all|--count] ──
  pi.registerCommand("mlist", {
    description: "Cross-file memory overview",
    getArgumentCompletions: (prefix: string) => {
      const text = prefix ?? "";
      const parts = text.split(/\s+/);
      const isAtEnd = text.endsWith(" ");
      const current = isAtEnd ? "" : parts[parts.length - 1];
      const flags = ["--active", "--resolved", "--all", "--count"];
      return flags.filter((f) => f.startsWith(current)).map((f) => ({ value: f, label: f, description: f }));
    },
    handler: (args, ctx) => {
      const flag = (args?.trim() ?? "--active").replace(/^\s*/, "");
      buildCrossFileTable(ctx, flag);
    },
  });

  // ── /memory archive ──
  pi.registerCommand("archive", {
    description: "Archive overflow memory entries",
    handler: (args, ctx) => {
      archiveMemory(ctx);
    },
  });

  // ── /memory config ──
  pi.registerCommand("config", {
    description: "Memory configuration settings",
    getArgumentCompletions: (prefix: string) => {
      const text = prefix ?? "";
      const parts = text.split(/\s+/);
      const isAtEnd = text.endsWith(" ");
      const done = isAtEnd ? parts.filter(Boolean) : parts.slice(0, -1);
      const current = isAtEnd ? "" : parts[parts.length - 1];

      const filter = (items: { value: string; label: string }[], tok: string) =>
        items.filter((i) => i.value.startsWith(tok));

      if (done.length === 0) {
        return filter([
          { value: "autoLog", label: "autoLog" },
          { value: "promptOnBlock", label: "promptOnBlock" },
          { value: "maxEntries", label: "maxEntries" },
          { value: "reset", label: "reset" },
        ], current);
      }
      const key = done[0];
      if (key === "autoLog" || key === "promptOnBlock") {
        return [{ value: "true", label: "true" }, { value: "false", label: "false" }].filter((i) => i.value.startsWith(current));
      }
      if (key === "maxEntries") return null;
      return [];
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const key = parts[0];
      const value = parts[1];
      if (!key) {
        showConfig(ctx);
        return;
      }
      if (key === "autoLog" && (value === "true" || value === "false")) {
        memoryConfig.autoLog = value === "true";
        pi.appendEntry("worrie-memory-config", { ...memoryConfig });
        ctx.ui.setStatus("worrie-memory", `[MEM] auto-log ${memoryConfig.autoLog ? "ON" : "OFF"}`);
        ctx.ui.notify(`autoLog ${memoryConfig.autoLog ? "ON" : "OFF"} - ${memoryConfig.autoLog ? "I will ask before saving" : "save manually with /m"}`, "info");
        return;
      }
      if (key === "promptOnBlock" && (value === "true" || value === "false")) {
        memoryConfig.promptOnBlock = value === "true";
        pi.appendEntry("worrie-memory-config", { ...memoryConfig });
        ctx.ui.notify(`promptOnBlock ${memoryConfig.promptOnBlock ? "ON" : "OFF"}`, "info");
        return;
      }
      if (key === "maxEntries" && /^\d+$/.test(value ?? "")) {
        memoryConfig.maxEntries = parseInt(value!, 10);
        pi.appendEntry("worrie-memory-config", { ...memoryConfig });
        ctx.ui.notify(`Archive threshold set to ${memoryConfig.maxEntries} entries`, "info");
        return;
      }
      if (key === "reset") {
        memoryConfig = { autoLog: true, promptOnBlock: true, maxEntries: 10 };
        pi.appendEntry("worrie-memory-config", { ...memoryConfig });
        ctx.ui.setStatus("worrie-memory", "[MEM] auto-log ON");
        ctx.ui.notify("Memory config reset to defaults", "info");
        return;
      }
      ctx.ui.notify("Usage: /memory config [autoLog|promptOnBlock|maxEntries|reset] [value]", "warning");
    },
  });

  // ── /clean ──
  pi.registerCommand("clean", {
    description:
      "Scan for junk files and debug traces, then remove approved items",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worrie-clean", "[CLEAN] scanning for artifacts...");
      const result: ScanResult = { junk: [], traces: [], empty: [] };
      scanForArtifacts(CWD, result);
      ctx.ui.setStatus("worrie-clean", undefined);
      const junk = [...result.junk, ...result.empty];
      if (junk.length === 0 && result.traces.length === 0) {
        ctx.ui.notify("Nothing to clean.", "info");
        return;
      }
      ctx.ui.notify(
        `Scan done. ${junk.length} junk/empty file(s), ${result.traces.length} debug trace(s).\nDebug traces are reported only - source files are never touched.\n${result.traces
          .slice(0, 10)
          .map((t) => `${t.file}:${t.line} ${t.text}`)
          .join("\n")}`,
        "info",
      );
      if (junk.length > 0) {
        const ok = await ctx.ui.confirm(
          "Delete junk files?",
          `${junk.length} file(s) marked for removal.`,
        );
        if (ok) {
          for (const f of junk) {
            try {
              rmSync(f, { force: true });
              ctx.ui.notify(
                `Removed ${f} - junk/empty file, no functional impact`,
                "info",
              );
            } catch {
              ctx.ui.notify(`REVIEW NEEDED: could not remove ${f}`, "warning");
            }
          }
          ctx.ui.notify(`Removed ${junk.length} junk file(s).`, "info");
        } else {
          ctx.ui.notify("Clean cancelled - nothing removed.", "info");
        }
      }
    },
  });

  // ── /obsidian ──
  pi.registerCommand("obsidian", {
    description:
      "Mirror workspace memory logs and config to your Obsidian vault",
    handler: async (_args, ctx) => {
      if (!setupDone()) {
        ctx.ui.notify(
          "Run /setup first to initialize the workspace.",
          "warning",
        );
        return;
      }
      let projectName = readWorkspaceName();

      const projMemory = join(CONFIG_DIR, "rules", "project_memory.md");
      let vault = "";
      let persist = false;
      if (existsSync(projMemory)) {
        const m = readFileSync(projMemory, "utf8").match(
          /\*\*Obsidian Vault Path\*\*: (.+)/,
        );
        if (m) vault = m[1].trim();
      }
      if (!vault) {
        const input = await ctx.ui.input(
          "Enter absolute path to your Obsidian vault:",
          "",
        );
        if (!input || !input.trim()) {
          ctx.ui.notify(
            "Obsidian sync cancelled - no vault path given.",
            "info",
          );
          return;
        }
        vault = input.trim().replace(/[\\/]+$/, "");
        persist = true;
      }

      const dest = join(vault, projectName);
      const jobs: Array<[string, string]> = [
        [WORKSPACE_FILE, "workspace.json"],
      ];
      if (existsSync(projMemory))
        jobs.push([projMemory, join("rules", "project_memory.md")]);
      for (const file of Object.keys(MEMORY_TEMPLATES)) {
        const p = join(MEMORY_DIR, file);
        if (existsSync(p)) jobs.push([p, join("memory", file)]);
      }
      for (const file of Object.keys(ARCHIVE_TEMPLATES)) {
        const p = join(ARCHIVES_DIR, file);
        if (existsSync(p)) jobs.push([p, join("archives", file)]);
      }
      if (existsSync(AGENTS_DIR)) {
        for (const entry of readdirSync(AGENTS_DIR)) {
          jobs.push([join(AGENTS_DIR, entry), join("agents", entry)]);
        }
      }
      const agentsMd = join(CONFIG_DIR, "..", "AGENTS.md");
      if (existsSync(agentsMd)) jobs.push([agentsMd, "AGENTS.md"]);

      let copied: string[] = [];
      try {
        for (const [src, rel] of jobs) {
          const target = join(dest, rel);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, readFileSync(src));
          copied.push(rel);
        }
      } catch (err) {
        ctx.ui.notify(`Obsidian sync failed: ${err}`, "error");
        return;
      }

      // persist the vault path for future runs (LIFO entry in project_memory)
      if (persist && existsSync(projMemory)) {
        const content = readFileSync(projMemory, "utf8");
        if (!/\*\*Obsidian Vault Path\*\*: /.test(content)) {
          const anchor = content.indexOf("\n## 1.");
          const line = `\n- **Obsidian Vault Path**: ${vault}\n`;
          const next =
            anchor >= 0
              ? content.slice(0, anchor) + line + content.slice(anchor)
              : content.replace(/\s*$/, "") + "\n" + line;
          writeFileSync(projMemory, next);
        }
      }

      ctx.ui.notify(
        `Obsidian sync complete. ${copied.length} file(s) mirrored to ${dest}\n${copied.join("\n")}`,
        "info",
      );
    },
  });

  // ── /rules ──
  pi.registerCommand("rules", {
    description:
      "Choose which rules to follow: default .pi rules, AGENTS.md, or CLAUDE.md",
    handler: async (_args, ctx) => {
      if (!setupDone()) {
        ctx.ui.notify(
          "Run /setup first to initialize the workspace.",
          "warning",
        );
        return;
      }
      const opts = rulesOptions();
      const picked = await ctx.ui.select(
        "Which rules should this workspace follow?",
        opts.map((o) => o.label),
      );
      if (!picked) return;
      const chosen = opts.find((o) => o.label === picked);
      if (!chosen) return;
      writeRulesSource(chosen.source);
      if (!applyRulesSource(chosen.source)) {
        ctx.ui.notify(
          `Could not write AGENTS.override.md for ${chosen.label}.`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(`Rules source set to ${chosen.label}.`, "info");
    },
  });

  // ── read-only enforcement (ask/plan) ──
  pi.on("tool_call", async (event, ctx) => {
    if (!activePersona) return;
    const p = PERSONAS[activePersona];
    if (!p || p.delegating) return;
    if (["bash", "write", "edit"].includes(event.toolName)) {
      if (memoryConfig.promptOnBlock) {
        ctx.ui.setStatus("worrie-blocked", "[BLOCKED] ask/plan is read-only");
      }
      return {
        block: true,
        reason: `${activePersona} is read-only. Use /normal or a write-capable persona.`,
      };
    }
  });

  // ── persona prompt injection ──
  pi.on("before_agent_start", async (event, ctx) => {
    if (activePersona) {
      return {
        systemPrompt:
          event.systemPrompt + "\n\n" + PERSONAS[activePersona].prompt,
      };
    }
  });

  // ── stage tracking from orchestrator subagent output ──
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "subagent") {
      const text = JSON.stringify(event.content ?? "");
      const stage = text.match(/\[STAGE (\d+\/\d+: [A-Z]+)\]/);
      if (stage)
        ctx.ui.setStatus("worrie-stage", `[ORCH-FULL] stage ${stage[1]}`);
      const loop = text.match(/\[LOOP (\d+\/\d+: [A-Z]+ -> [A-Z]+)\]/);
      if (loop) ctx.ui.setStatus("worrie-stage", `[ORCH-FULL] loop ${loop[1]}`);
    }
  });

  // ── turn end: clear temp statuses, restore after delegation, auto-log wizard ──
  pi.on("agent_settled", async (_event, ctx) => {
    ctx.ui.setStatus("worrie-subagent", undefined);
    ctx.ui.setStatus("worrie-blocked", undefined);
    ctx.ui.setStatus("worrie-stage", undefined);
    if (activePersona && PERSONAS[activePersona].delegating) {
      activePersona = null;
      if (savedTools) {
        pi.setActiveTools(savedTools);
        savedTools = null;
      }
      ctx.ui.setStatus("worrie-persona", "[NORMAL]");
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    ctx.ui.setStatus("worrie-subagent", undefined);
    ctx.ui.setStatus("worrie-blocked", undefined);
    // auto-log wizard for main-session personas (ask/plan) when work happened
    if (
      activePersona &&
      !PERSONAS[activePersona].delegating &&
      memoryConfig.autoLog &&
      (event.toolResults?.length ?? 0) > 0
    ) {
      const ok = await ctx.ui.confirm(
        "Save to memory?",
        "Document this session?",
      );
      if (ok) {
        const type = await ctx.ui.input(
          "Memory type:",
          "err / code / impl / sec / rev / test / proj",
        );
        const msg = await ctx.ui.input("Message:", "");
        if (MEMORY_TYPES[type ?? ""] && msg) logMemory(ctx, type!, msg);
        else ctx.ui.notify("Cancelled - nothing saved.", "info");
      }
    }
  });
}
