/**
 * persona-skills extension
 * c: worrie
 *
 * Persona system + memory tracking for pi-worrie.
 * 9 personas (/ask /plan /coder /debugger /orchestrator /orch-full /reviewer /secure /tester)
 * Memory system (/memory log|show|list|resolve|edit|search|archive|config)
 * Setup (/setup), Clean (/clean), Normal (/normal)
 *
 * Read-only personas (ask, plan) work in the main session.
 * All other personas delegate to worrie-* subagents to keep the main context clean.
 */
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

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const SHELL_TOOLS = [...READ_ONLY_TOOLS, "subagent", "subagent_wait"];

// Short memory type names -> file + tracking prefix (null prefix = no tracking numbers)
const MEMORY_TYPES: Record<string, { file: string; prefix: string | null; title: string }> = {
  err: { file: "error_memory.md", prefix: "ERR", title: "Errors" },
  code: { file: "codebase_map.md", prefix: null, title: "Codebase Map" },
  impl: { file: "implementation_memory.md", prefix: "FLOW", title: "Implementation" },
  sec: { file: "security_memory.md", prefix: "SEC", title: "Security" },
  rev: { file: "review_memory.md", prefix: "REVIEW", title: "Review" },
  test: { file: "test_memory.md", prefix: "TEST", title: "Test" },
  proj: { file: join("..", "rules", "project_memory.md"), prefix: null, title: "Project" },
};

const ARCHIVE_MAP: Record<string, { file: string; archive: string }> = {
  err: { file: "error_memory.md", archive: "error_archive.md" },
  impl: { file: "implementation_memory.md", archive: "implementation_archive.md" },
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
  const date = d.toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "long", day: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: true });
  return `${date}, ${time} PST`;
}

function memPath(type: string): string {
  const t = MEMORY_TYPES[type];
  return t ? join(MEMORY_DIR, t.file) : "";
}

function setupDone(): boolean {
  try {
    if (!existsSync(WORKSPACE_FILE)) return false;
    const ws = JSON.parse(readFileSync(WORKSPACE_FILE, "utf8"));
    return !!ws.workspace_id && ws.workspace_id !== "uninitialized";
  } catch {
    return false;
  }
}

function nextTrackingId(content: string, prefix: string): string {
  const re = new RegExp(`### \\[${prefix}-(\\d+)\\]`, "g");
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
    if (!line.startsWith("### [")) continue;
    const active = line.match(/^### \[([A-Z]+-\d+)\]/);
    if (active) {
      ids.push(active[1]);
      continue;
    }
    const resolved = line.match(/^### \[RESOLVED\][^\n]*\(([A-Z]+-\d+)\)/);
    if (resolved && includeResolved) ids.push(resolved[1]);
  }
  return ids;
}

// ===================================================================
// Agent file templates (written by /setup)
// ===================================================================

// Agent specs: persona comes from ../skills/<dir>/SKILL.md (identical to .pi/skills).
// /setup injects the tools frontmatter, appends memory protocol + output contract,
// then attaches the WORKSPACE RULES section from ../rules/ (identical to .pi/rules).
const AGENT_SPECS: Record<string, { skill: string; tools: string; memoryProtocol?: string; outputContract?: string }> = {
  "worrie-planner.md": {
    skill: "planner",
    tools: "read, grep, find, ls",
    outputContract: `## Output Contract
Return to the parent: the plan summary only - key steps, files involved, risks. Keep it concise.
`,
  },
  "worrie-coder.md": {
    skill: "coder",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol (MANDATORY)
- You may write to ANY memory file as relevant to the task:
  - \`err\` -> .pi/memory/error_memory.md (ERR-NNN)
  - \`code\` -> .pi/memory/codebase_map.md (follow its layer format: FN-FE / FILE-FE / DB / STG / SVC / DEP / OPS)
  - \`impl\` -> .pi/memory/implementation_memory.md (FLOW-NNN)
  - \`sec\` -> .pi/memory/security_memory.md (SEC-NNN)
  - \`rev\` -> .pi/memory/review_memory.md (REVIEW-NNN)
  - \`test\` -> .pi/memory/test_memory.md (TEST-NNN)
  - \`proj\` -> .pi/rules/project_memory.md
- New entries go to the TOP of Section 1 (LIFO), with format:
  \`### [FLOW-004] Short Title\` followed by structured bullet fields.
- STRICT ID RULES: always square brackets + 3-digit zero-padded number ([ERR-001], [FLOW-007], [REVIEW-012], [SEC-003], [TEST-002]). Never omit brackets, never drop padding.
- NEVER delete, truncate, or rewrite existing entries.
`,
    outputContract: `## Output Contract
Return to the parent: files changed, logic added, validation run, memory entries written (IDs). Keep it concise.
`,
  },
  "worrie-debugger.md": {
    skill: "debugger",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol (MANDATORY)
- DEFAULT: log to \`.pi/memory/error_memory.md\` (ERR-NNN).
  - Active blockers -> Section 1, LIFO top: \`### [ERR-NNN] Short Title\`
  - Fixed bugs -> SAME response, move to Section 2: \`### [RESOLVED] Short Title (ERR-NNN)\` keeping the original number.
- When the user explicitly asks, you may also write ANY other memory file (code, impl, sec, rev, test, proj).
- NEVER delete, truncate, or rewrite entries in Section 2.
`,
    outputContract: `## Output Contract
Return to the parent: root cause, files changed, fix summary, memory entry IDs written (ERR-XXX). Keep it concise.
`,
  },
  "worrie-orchestrator.md": {
    skill: "orchestrator",
    tools: "read, grep, find, ls, bash, write, edit, subagent, subagent_wait",
    memoryProtocol: `## Memory Protocol (MANDATORY)
- Write to whichever memory file matches the persona/stage currently executing:
  - PLAN/DOCUMENT -> impl + proj
  - CODE -> impl
  - TEST -> test
  - DEBUG -> err
  - SECURE -> sec
  - REVIEW -> rev
- New entries go to the TOP of Section 1 (LIFO). NEVER delete existing entries.
`,
    outputContract: `## Output Contract
Return to the parent: stages completed, subagents used, memory entries written (IDs). Keep it concise.
`,
  },
  "worrie-reviewer.md": {
    skill: "reviewer",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol (MANDATORY)
- Log findings to \`.pi/memory/review_memory.md\` (REVIEW-NNN):
  - Active findings -> Section 1, LIFO top: \`### [REVIEW-NNN] Short Title\`
  - Resolved findings -> SAME response, move to Section 2: \`### [RESOLVED] Short Title (REVIEW-NNN)\` keeping the original number.
- NEVER delete, truncate, or rewrite entries in Section 2.
`,
    outputContract: `## Output Contract
Return to the parent: findings with severity, files reviewed, memory entry IDs written. Keep it concise.
`,
  },
  "worrie-secure.md": {
    skill: "secure",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol (MANDATORY)
- Log vulnerabilities to \`.pi/memory/security_memory.md\` (SEC-NNN):
  - Active -> Section 1, LIFO top: \`### [SEC-NNN] Short Title (SEVERITY)\`
  - Patched -> SAME response, move to Section 2: \`### [RESOLVED] Short Title (SEC-NNN)\` and update the Overall Security Score.
- NEVER delete, truncate, or rewrite entries in Section 2.
`,
    outputContract: `## Output Contract
Return to the parent: vulnerabilities found, security score, remediation plan, memory entry IDs. Keep it concise.
`,
  },
  "worrie-tester.md": {
    skill: "tester",
    tools: "read, grep, find, ls, bash, write, edit",
    memoryProtocol: `## Memory Protocol (MANDATORY)
- Log strategies to \`.pi/memory/test_memory.md\` (TEST-NNN):
  - Active -> Section 1, LIFO top: \`### [TEST-NNN] Short Title\`
  - Resolved -> SAME response, move to Section 2: \`### [RESOLVED] Short Title (TEST-NNN)\` keeping the original number.
- NEVER delete, truncate, or rewrite entries in Section 2.
`,
    outputContract: `## Output Contract
Return to the parent: stages run, pass/fail per stage, coverage numbers, memory entry IDs. Keep it concise.
`,
  },
};

// ===================================================================
// Agent file construction: persona (../skills) + protocol + WORKSPACE RULES
// ===================================================================

/** Directory of this extension file (works under jiti CJS and ESM loading). */
function extensionDir(): string {
  try {
    const { fileURLToPath } = require("node:url");
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
    const sys = readFileSync(join(PKG_ROOT, "rules", "system_instructions.md"), "utf8");
    return `${cli}\n\n---\n\n${sys}`;
  } catch {
    return "";
  }
}

const RULES_START = "## WORKSPACE RULES (pi-worrie -- immutable)";
const RULES_END = "<!-- end worrie workspace rules -->";

function rulesBlock(rulesText: string): string {
  return `${RULES_START}\n\n${rulesText}\n\n${RULES_END}`;
}

/**
 * Build the full agent file content for one spec:
 * skill persona (with injected tools frontmatter) + memory protocol +
 * output contract + workspace rules section.
 */
function buildAgentFile(
  spec: { skill: string; tools: string; memoryProtocol?: string; outputContract?: string },
  rulesText: string,
): string {
  const skillPath = join(PKG_ROOT, "skills", spec.skill, "SKILL.md");
  let skill = readFileSync(skillPath, "utf8");
  if (skill.startsWith("---")) {
    const end = skill.indexOf("\n---", 3);
    if (end > 0) {
      skill = skill.slice(0, end) + `\ntools: ${spec.tools}\nsystemPromptMode: replace\ninheritProjectContext: true` + skill.slice(end);
    }
  }
  const extra = [spec.memoryProtocol, spec.outputContract].filter(Boolean).join("\n");
  return skill + (extra ? `\n\n${extra}` : "") + "\n\n" + rulesBlock(rulesText) + "\n";
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
  const eIdx = content.indexOf(RULES_END);
  let next: string;
  if (sIdx >= 0 && eIdx >= 0) {
    const head = content.slice(0, sIdx).replace(/\s+$/, "");
    const tail = content.slice(eIdx + RULES_END.length).replace(/^\s+/, "");
    next = tail ? `${head}\n\n${block}\n\n${tail}` : `${head}\n\n${block}\n`;
  } else if (sIdx >= 0) {
    next = content.slice(0, sIdx).replace(/\s+$/, "") + "\n\n" + block + "\n";
  } else {
    next = content.replace(/\s+$/, "") + "\n\n" + block + "\n";
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
    return readFileSync(join(PKG_ROOT, "templates", "rules", "project_memory.md"), "utf8");
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
    ctx.ui.notify(`Memory file for "${type}" missing. Run /setup first.`, "warning");
    return;
  }
  const t = MEMORY_TYPES[type];
  const content = readFileSync(file, "utf8");
  const id = t.prefix ? nextTrackingId(content, t.prefix) : null;
  const title = message.split("\n")[0].slice(0, 80);
  const entry = buildMemoryEntry(type, id, title, message);
  const sec1 = content.indexOf("## 1.");
  const insertAt = sec1 === -1 ? content.length : sec1 + content.slice(sec1).indexOf("\n") + 1;
  writeFileSync(file, content.slice(0, insertAt) + "\n" + entry + content.slice(insertAt));
  ctx.ui.notify(`Logged ${id ?? type} to ${t.file}`, "info");
}

/**
 * Build a memory entry using the exact per-type field formats from the
 * user's workflow templates (templates/memory/*.md).
 */
function buildMemoryEntry(type: string, id: string | null, title: string, message: string): string {
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
    ctx.ui.notify(`Memory file for "${type}" missing. Run /setup first.`, "warning");
    return;
  }
  const content = readFileSync(file, "utf8");
  const blocks = content.split("\n### ").slice(1).map((b) => "### " + b);
  const entries = blocks.filter((b) => /^### \[(RESOLVED\] |[A-Z]+-\d+\])/.test(b));
  let list = entries;
  if (opt === "--open") list = entries.filter((b) => !b.startsWith("### [RESOLVED]"));
  else if (opt === "--resolved") list = entries.filter((b) => b.startsWith("### [RESOLVED]"));
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
    ctx.ui.notify(`Resolved ${id}: Status -> COMPLETED (impl entries stay in Section 1 per workflow format).`, "info");
    return;
  }
  if (type === "code" || type === "proj") {
    ctx.ui.notify(`${type} entries follow the workflow structure and are not moved to Section 2.`, "info");
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
  while (ins < lines.length && (lines[ins].trim() === "" || lines[ins].startsWith("_") || lines[ins].startsWith(">"))) ins++;
  lines.splice(ins, 0, ...block, "");
  writeFileSync(file, lines.join("\n"));
  ctx.ui.notify(`Resolved ${id}. Moved to Section 2 as [RESOLVED] ${title} (${id})`, "info");
}

function editMemory(ctx: any, type: string, id: string, field: string, value: string): void {
  const file = memPath(type);
  if (!file || !existsSync(file)) {
    ctx.ui.notify(`Memory file for "${type}" missing.`, "warning");
    return;
  }
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  const start = lines.findIndex(
    (l) => l.startsWith(`### [${id}]`) || (l.startsWith("### [RESOLVED]") && l.includes(`(${id})`)),
  );
  if (start === -1) {
    ctx.ui.notify(`Entry ${id} not found.`, "warning");
    return;
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith("### ["));
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
    .filter(({ l }) => l.toLowerCase().includes(query.toLowerCase()) && l.trim() !== "");
  if (hits.length === 0) {
    ctx.ui.notify(`No matches for "${query}" in ${MEMORY_TYPES[type].file}`, "info");
    return;
  }
  const out = hits.slice(0, 20).map(({ l, i }) => `line ${i}: ${l.trim().slice(0, 90)}`).join("\n");
  ctx.ui.notify(`${hits.length} match(es) in ${MEMORY_TYPES[type].file}:\n${out}`, "info");
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
      archiveContent.slice(insertAt).replace("## Archived Entries", "## Archived Entries\n" + archived.join("\n"));
    const totalMatch = archiveContent.match(/- \*\*Total Entries Archived\*\*: (\d+)/);
    const total = totalMatch ? parseInt(totalMatch[1], 10) + overflow : overflow;
    writeFileSync(
      dst,
      withEntries
        .replace(/- \*\*Last Archived At\*\*: .+/, `- **Last Archived At**: ${pstNow()}`)
        .replace(/- \*\*Total Entries Archived\*\*: \d+/, `- **Total Entries Archived**: ${total}`)
        .replace(/\(No entries archived yet\)\n?/, ""),
    );
    writeFileSync(src, lines.join("\n"));
    moved += overflow;
    ctx.ui.notify(`[ARCHIVAL] Moved ${overflow} entries from ${file} to ${archive}`, "info");
  }
  if (moved === 0) ctx.ui.notify("Nothing to archive - all sections within limit.", "info");
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
const TEXT_EXTS = [".ts", ".js", ".tsx", ".jsx", ".md", ".json", ".py", ".css", ".html", ".vue", ".rs", ".go"];
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
            result.traces.push({ file: full, line: i + 1, text: l.trim().slice(0, 90) });
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
          if (data?.persona && PERSONAS[data.persona]) activePersona = data.persona;
        }
        if (entry.type === "custom" && entry.customType === "worrie-memory-config") {
          const data = entry.data as Partial<typeof memoryConfig> | undefined;
          if (data) memoryConfig = { ...memoryConfig, ...data };
        }
      }
    } catch {
      // ephemeral session
    }
    if (!setupDone()) {
      ctx.ui.setStatus("worrie-setup", "[SETUP] not initialized - run /setup");
    }
    ctx.ui.setStatus("worrie-memory", `[MEM] auto-log ${memoryConfig.autoLog ? "ON" : "OFF"}`);
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
    description: "Initialize workspace: workspace.json, memory files, agent files",
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
        const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        let wsTemplate = "";
        try {
          wsTemplate = readFileSync(join(PKG_ROOT, "templates", "workspace.json"), "utf8");
        } catch {
          // fall back to plain JSON if template missing
        }
        writeFileSync(
          WORKSPACE_FILE,
          wsTemplate
            ? wsTemplate
                .replace("__WORRIE_SLUG__", slug)
                .replace("__WORRIE_NAME__", name)
                .replace("__WORRIE_AT__", pstNow())
                .replace("__WORRIE_BY__", "pi-worrie")
            : JSON.stringify(
                { workspace_id: slug, project_name: name, initialized_at: pstNow(), initialized_by: "pi-worrie" },
                null,
                2,
              ),
        );
        ctx.ui.notify(`WORKSPACE INITIALIZED: ${name} | ID: ${slug}`, "info");
      } else {
        let name = "unknown";
        try {
          name = JSON.parse(readFileSync(WORKSPACE_FILE, "utf8")).project_name ?? "unknown";
        } catch {
          // ignore
        }
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
      const rulesText = loadWorkspaceRules();
      let agents = 0;
      for (const [file, spec] of Object.entries(AGENT_SPECS)) {
        const agentPath = join(AGENTS_DIR, file);
        if (!existsSync(agentPath)) {
          writeFileSync(agentPath, buildAgentFile(spec as any, rulesText));
          agents++;
        } else if (rulesText && refreshRulesSection(agentPath, rulesText)) {
          agents++;
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
          ctx.ui.notify("Run /setup first to initialize the workspace.", "warning");
          return;
        }
        if (!savedTools) savedTools = pi.getActiveTools();
        activePersona = name;
        pi.setActiveTools(p.tools);
        ctx.ui.setStatus("worrie-persona", p.status);
        if (p.delegating && p.agent) {
          ctx.ui.setStatus("worrie-subagent", `[SUBAGENT] ${p.agent} working...`);
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

  // ── /memory ──
  pi.registerCommand("memory", {
    description: "Memory management: log, show, list, resolve, edit, search, archive, config",
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

      const SUBCOMMANDS = [
        { value: "log", label: "log", description: "Create a new memory entry" },
        { value: "show", label: "show", description: "View memory entries" },
        { value: "list", label: "list", description: "All memory files with open/resolved counts" },
        { value: "resolve", label: "resolve", description: "Move entry to Section 2 as RESOLVED" },
        { value: "edit", label: "edit", description: "Edit a field in an entry" },
        { value: "search", label: "search", description: "Search entries" },
        { value: "archive", label: "archive", description: "Archive overflow entries" },
        { value: "config", label: "config", description: "Memory settings" },
      ];
      const TYPES = Object.entries(MEMORY_TYPES).map(([key, t]) => ({
        value: key,
        label: key,
        description: `${t.title} -> .pi/${t.file}`,
      }));
      const typeKeys = Object.keys(MEMORY_TYPES);

      const sub = done[0];
      if (!sub) return filter(SUBCOMMANDS, current);
      if (!SUBCOMMANDS.some((s) => s.value === sub)) return filter(SUBCOMMANDS, current);

      if (sub === "log" || sub === "search") {
        if (done.length === 1) return filter(TYPES, current);
        return null; // free-text message
      }
      if (sub === "show" || sub === "resolve" || sub === "edit") {
        if (done.length === 1) return filter(TYPES, current);
        const type = done[1];
        if (!typeKeys.includes(type)) return null;
        if (sub === "show") {
          const flags = [
            { value: "--all", label: "--all", description: "All entries (active + resolved)" },
            { value: "--open", label: "--open", description: "Active entries only" },
            { value: "--resolved", label: "--resolved", description: "Resolved entries only" },
          ];
          const ids = memoryEntryIds(type, true).map((id) => ({ value: id, label: id, description: `Entry ${id}` }));
          return filter([...flags, ...ids], current);
        }
        const ids = memoryEntryIds(type, sub === "edit").map((id) => ({
          value: id,
          label: id,
          description: `Entry ${id}`,
        }));
        return filter(ids, current);
      }
      if (sub === "list" || sub === "archive") return null; // no more args
      if (sub === "config") {
        if (done.length === 1) {
          return filter(
            [
              { value: "autoLog", label: "autoLog", description: "Ask before saving after read-only work" },
              { value: "promptOnBlock", label: "promptOnBlock", description: "Show BLOCKED status on write attempts" },
              { value: "maxEntries", label: "maxEntries", description: "Archive threshold (number)" },
              { value: "reset", label: "reset", description: "Restore defaults" },
            ],
            current,
          );
        }
        if (done[1] === "autoLog" || done[1] === "promptOnBlock") {
          return filter(
            [
              { value: "true", label: "true", description: "Enable" },
              { value: "false", label: "false", description: "Disable" },
            ],
            current,
          );
        }
        return null; // maxEntries expects a number, reset takes nothing
      }
      return null;
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0] ?? "";
      const rest = parts.slice(1);

      switch (sub) {
        case "log": {
          const type = rest[0];
          let message = rest.slice(1).join(" ").trim();
          if (message.startsWith('"') && message.endsWith('"')) message = message.slice(1, -1);
          if (!MEMORY_TYPES[type] || !message) {
            ctx.ui.notify('Usage: /memory log <err|code|impl|sec|rev|test|proj> "message"', "warning");
            return;
          }
          logMemory(ctx, type, message);
          return;
        }
        case "show": {
          const type = rest[0];
          const opt = rest[1] ?? "";
          if (!MEMORY_TYPES[type]) {
            ctx.ui.notify("Usage: /memory show <err|code|impl|sec|rev|test|proj> [n|--all|--open|--resolved|ID]", "warning");
            return;
          }
          showMemory(ctx, type, opt);
          return;
        }
        case "list": {
          const rows = Object.entries(MEMORY_TYPES).map(([key, t]) => {
            const path = join(MEMORY_DIR, t.file);
            if (!existsSync(path)) return `${key.padEnd(4)} ${t.title.padEnd(14)} (missing)`;
            const content = readFileSync(path, "utf8");
            const blocks = content.split("\n### ").slice(1).map((b) => "### " + b);
            const total = blocks.filter((b) => /^### \[(RESOLVED\] |[A-Z]+-\d+\])/.test(b)).length;
            const resolved = blocks.filter((b) => b.startsWith("### [RESOLVED]")).length;
            return `${key.padEnd(4)} ${t.title.padEnd(14)} open: ${total - resolved}  resolved: ${resolved}  total: ${total}`;
          });
          ctx.ui.notify(`Memory files:\n${rows.join("\n")}`, "info");
          return;
        }
        case "resolve": {
          const type = rest[0];
          const id = (rest[1] ?? "").toUpperCase();
          if (!MEMORY_TYPES[type] || !id) {
            ctx.ui.notify("Usage: /memory resolve <type> <ID>", "warning");
            return;
          }
          resolveMemory(ctx, type, id);
          return;
        }
        case "edit": {
          const type = rest[0];
          const id = (rest[1] ?? "").toUpperCase();
          const remainder = rest.slice(2).join(" ").replace(/^"/, "").replace(/"$/, "").trim();
          const fm = remainder.match(/^([A-Za-z ]+):\s*(.+)$/);
          if (!MEMORY_TYPES[type] || !id || !fm) {
            ctx.ui.notify('Usage: /memory edit <type> <ID> "Field: value"', "warning");
            return;
          }
          editMemory(ctx, type, id, fm[1].trim(), fm[2].trim());
          return;
        }
        case "search": {
          const type = rest[0];
          const query = rest.slice(1).join(" ").replace(/^"|"$/g, "").trim();
          if (!MEMORY_TYPES[type] || !query) {
            ctx.ui.notify("Usage: /memory search <type> <query>", "warning");
            return;
          }
          searchMemory(ctx, type, query);
          return;
        }
        case "archive": {
          archiveMemory(ctx);
          return;
        }
        case "config": {
          const key = rest[0];
          const value = rest[1];
          if (!key) {
            showConfig(ctx);
            return;
          }
          if (key === "autoLog" && (value === "true" || value === "false")) {
            memoryConfig.autoLog = value === "true";
            pi.appendEntry("worrie-memory-config", { ...memoryConfig });
            ctx.ui.setStatus("worrie-memory", `[MEM] auto-log ${memoryConfig.autoLog ? "ON" : "OFF"}`);
            ctx.ui.notify(`autoLog ${memoryConfig.autoLog ? "ON" : "OFF"} - ${memoryConfig.autoLog ? "I will ask before saving" : "save manually with /memory log"}`, "info");
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
          ctx.ui.notify("Usage: /memory config [autoLog true|false] [promptOnBlock true|false] [maxEntries N] [reset]", "warning");
          return;
        }
        default:
          ctx.ui.notify("Usage: /memory <log|show|list|resolve|edit|search|archive|config> ...", "warning");
      }
    },
  });

  // ── /clean ──
  pi.registerCommand("clean", {
    description: "Scan for junk files and debug traces, then remove approved items",
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
        `Scan done. ${junk.length} junk/empty file(s), ${result.traces.length} debug trace(s).\nDebug traces are reported only - source files are never touched.\n${result.traces.slice(0, 10).map((t) => `${t.file}:${t.line} ${t.text}`).join("\n")}`,
        "info",
      );
      if (junk.length > 0) {
        const ok = await ctx.ui.confirm("Delete junk files?", `${junk.length} file(s) marked for removal.`);
        if (ok) {
          for (const f of junk) {
            try {
              rmSync(f, { force: true });
              ctx.ui.notify(`Removed ${f} - junk/empty file, no functional impact`, "info");
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

  // ── read-only enforcement (ask/plan) ──
  pi.on("tool_call", async (event, ctx) => {
    if (!activePersona) return;
    const p = PERSONAS[activePersona];
    if (!p || p.delegating) return;
    if (["bash", "write", "edit"].includes(event.toolName)) {
      if (memoryConfig.promptOnBlock) {
        ctx.ui.setStatus("worrie-blocked", "[BLOCKED] ask/plan is read-only");
      }
      return { block: true, reason: `${activePersona} is read-only. Use /normal or a write-capable persona.` };
    }
  });

  // ── persona prompt injection ──
  pi.on("before_agent_start", async (event, ctx) => {
    if (activePersona) {
      return { systemPrompt: event.systemPrompt + "\n\n" + PERSONAS[activePersona].prompt };
    }
  });

  // ── stage tracking from orchestrator subagent output ──
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "subagent") {
      const text = JSON.stringify(event.content ?? "");
      const stage = text.match(/\[STAGE (\d+\/\d+: [A-Z]+)\]/);
      if (stage) ctx.ui.setStatus("worrie-stage", `[ORCH-FULL] stage ${stage[1]}`);
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
      const ok = await ctx.ui.confirm("Save to memory?", "Document this session?");
      if (ok) {
        const type = await ctx.ui.input("Memory type:", "err / code / impl / sec / rev / test / proj");
        const msg = await ctx.ui.input("Message:", "");
        if (MEMORY_TYPES[type ?? ""] && msg) logMemory(ctx, type!, msg);
        else ctx.ui.notify("Cancelled - nothing saved.", "info");
      }
    }
  });
}
