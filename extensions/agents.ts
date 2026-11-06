// Personas + memory system for pi-worrie. c: worrie
// Single-letter persona commands match uveworkflow flags.
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
import { execSync } from "child_process";
import {
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
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

function memPath(type: string): string {
  const t = MEMORY_TYPES[type];
  return t ? join(MEMORY_DIR, t.file) : "";
}

function setupDone(): boolean {
  const ws = readWorkspace();
  return !!ws?.workspace_id && ws.workspace_id !== "uninitialized";
}

function nextTrackingId(content: string, prefix: string): string {
  const re = new RegExp(`###+ \\[${prefix}-(\\d+)\\]`, "g");
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) max = Math.max(max, parseInt(m[1], 10));
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}


// ===================================================================
// Tool sets
// ===================================================================

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const SHELL_TOOLS = [...READ_ONLY_TOOLS, "subagent", "subagent_wait"];

// ===================================================================
// Memory types + archive map
// ===================================================================

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

// ===================================================================
// Persona definitions (single-letter commands)
// ===================================================================

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
  a: {
    tools: READ_ONLY_TOOLS,
    delegating: false,
    status: "[ASK] read-only",
    prompt:
      "You are the ASK persona: a read-only technical assistant. You may read, grep, find, and ls files to locate and analyze code. NEVER write, edit, or run bash. Answer with clear, structured explanations.",
    delegation: (task) => task,
  },
  p: {
    tools: READ_ONLY_TOOLS,
    delegating: false,
    status: "[PLAN] read-only",
    prompt:
      "You are the PLAN persona: a read-only planner. You may read, grep, find, and ls files to gather context. NEVER write, edit, or run bash. Produce a structured engineering plan and WAIT for user approval before any implementation.",
    delegation: (task) => task,
  },
  c: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-coder",
    status: "[CODER] active",
    prompt:
      "You are the CODER coordinator. Do NOT implement anything yourself in this session. Launch the worrie-coder subagent and present its concise summary to the user.",
    delegation: (task) =>
      `Launch the worrie-coder subagent with the task below. Do NOT implement anything in this session. Await the subagent result and present a concise summary: files changed, logic added, memory entries written.\n\nTask: ${task}`,
  },
  d: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-debugger",
    status: "[DEBUGGER] active",
    prompt:
      "You are the DEBUGGER coordinator. Do NOT debug in this session yourself. Launch the worrie-debugger subagent and present its concise summary to the user.",
    delegation: (task) =>
      `Launch the worrie-debugger subagent with the problem below. Do NOT debug in this session yourself. Await the result and present a concise summary: root cause, files changed, fix applied, memory entries written.\n\nProblem: ${task}`,
  },
  o: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-orchestrator",
    status: "[ORCH] auto-detect",
    prompt:
      "You are the ORCHESTRATOR coordinator. Launch the worrie-orchestrator subagent in AUTO-DETECT mode: it picks the right persona from the user's prompt. Present its summary.",
    delegation: (task) => {
      if (task.toLowerCase().startsWith("auto ")) {
        const userTask = task.slice(5).trim();
        return `Call the subagent tool ONCE with a chain. The chain parameter MUST be a JSON array of objects — never a stringified array. Do NOT do the work in this session. Use exactly this structure (TASK = the task below):

subagent({
  chain: [
    { agent: "worrie-planner", task: "PLAN: produce a structured roadmap with clear steps for: TASK", label: "1/11: PLAN" },
    { agent: "worrie-coder", task: "CODE: implement the approved plan (use {previous}). TASK", label: "2/11: CODE", approval: true },
    { agent: "worrie-tester", task: "TEST: run typecheck, lint, unit, integration, E2E, coverage. Summarize pass/fail.", label: "3/11: TEST", approval: true },
    { agent: "worrie-debugger", task: "DEBUG: fix any failures from {previous}, explain root causes", label: "4/11: DEBUG", approval: true },
    { agent: "worrie-secure", task: "SECURE: OWASP scan of new code, score 0-10", label: "5/11: SECURE", approval: true },
    { agent: "worrie-debugger", task: "DEBUG: catch bugs introduced by security fixes", label: "6/11: DEBUG", approval: true },
    { agent: "worrie-tester", task: "TEST: full pipeline again", label: "7/11: TEST", approval: true },
    { agent: "worrie-coder", task: "CLEAN: report debug traces and dead code (safe removals only)", label: "8/11: CLEAN", approval: true },
    { agent: "worrie-reviewer", task: "REVIEW: findings with severity", label: "9/11: REVIEW", approval: true },
    { agent: "worrie-coder", task: "DOCUMENT: write summary to implementation_memory.md and project_memory.md", label: "10/11: DOCUMENT", approval: true }
  ]
})

After the chain finishes, present the final summary to the user and ask what's next.

TASK: ${userTask}`;
      }
      return `Launch the worrie-orchestrator subagent in AUTO-DETECT mode. It analyzes the user prompt and chooses the matching persona (coder, debugger, reviewer, secure, tester, ask logic). Do NOT do the work in this session. Present the concise summary.\n\nPrompt: ${task}`;
    },
  },
  s: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-secure",
    status: "[SECURE] active",
    prompt:
      "You are the SECURE coordinator. Launch the worrie-secure subagent and present its security assessment to the user.",
    delegation: (task) =>
      `Launch the worrie-secure subagent for the security target below. Do NOT scan in this session yourself. Await the result and present a concise assessment (vulnerabilities, score 0-10, remediation).\n\nTarget: ${task}`,
  },
  r: {
    tools: SHELL_TOOLS,
    delegating: true,
    agent: "worrie-reviewer",
    status: "[REVIEWER] active",
    prompt:
      "You are the REVIEWER coordinator. Launch the worrie-reviewer subagent and present its findings summary to the user.",
    delegation: (task) =>
      `Launch the worrie-reviewer subagent for the review target below. Do NOT review in this session yourself. Await the result and present a concise findings summary (severity, file, recommendation).\n\nTarget: ${task}`,
  },
  t: {
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
let memoryConfig = { promptOnBlock: true, maxEntries: 10 };

// ===================================================================
// Agent file construction (installed globally from embed skills)
// ===================================================================

function extensionDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    // FSM context when import.meta unusable — parent of extensions dir
    return dirname(process.argv[1] ?? process.cwd());
  }
}

const PKG_ROOT = join(extensionDir(), "..");

// pi-worrie mapping section appended to the injected rules text
const FLAG_MAP = `## pi-worrie Flag Mapping
This full rule text is injected into every pi session by the pi-worrie extension.
BAN writing rules as md files into the workspace — memory and archive files under
\`.pi/\` are the only workspace artifacts of this workflow.

Dash-flag rules in this file map to same-named slash commands in pi:
- \`/init\` — \`-init\` plus the full \`-setup\` chain: creates \`workspace.json\` plus \`.pi/memory/\` + \`.pi/archives/\` only
- \`/context\` / \`/error\` / \`/codebase\` — flag-triggered updates handled via prompts
- \`/archive\` / \`/clean\` — per \`Archival\` / \`System Clean\`
- \`/obsidian\` / \`/update\` — per \`OBSIDIAN SYNC\` / \`UPDATE FLAG\`; update refreshes the extension's internal rules+skills and regenerates the global worrie-* agents
- \`/normal\` — exit persona mode, restore tools (pi extension equivalent)
- Personas: \`/a /p /c /d /o /s /r /t\` — \`FINDINGS GATE\` applies, logs first
- pi-extension helpers: \`/subagents\` \`/updater\` \`/worrie-themed\`
- No memory list commands: the AI reads memory files directly per this file.`;

function loadWorkspaceRules(): string {
  try {
    return readFileSync(
      join(extensionDir(), "embed", "rules", "instructions.md"),
      "utf8",
    );
  } catch {
    return "";
  }
}

// rules injected into EVERY pi session (upstream text + pi-worrie mapping)
const INJECTED_RULES = `${loadWorkspaceRules().replace(
  /\s*<!-- c: worrie -->\s*$/,
  "",
).replace(/\s+$/, "")}\n\n${FLAG_MAP}`;

const GLOBAL_AGENTS_DIR = join(getAgentDir(), "agents");

const SUBAGENT_RULES_SECTIONS = [
  "System Boundaries",
  "Strict Rule Modification Constraints",
  "Mandatory Timestamp",
  "LIFO Sorting",
  "Beginner Clarity",
  "Header & Log Protection",
  "Data Retention",
  "Resolution Mandates (Test/Review/Security/Error)",
];

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
const RULES_END = "<!-- c: worrie -->";

function rulesBlock(rulesText: string): string {
  return `${RULES_START}\n\n${rulesText}`;
}

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
- § \`instructions.md\` §pi-worrie Flag Mapping for commands.
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

function buildAgentFile(
  spec: { skill: string; tools: string; memoryProtocol?: string },
  rulesText: string,
  agentName: string,
): string {
  const skillPath = join(PKG_ROOT, "extensions", "embed", "skills", spec.skill, "SKILL.md");
  let skill = readFileSync(skillPath, "utf8");
  skill = skill.replace(/\s*<!--\s*c: worrie\s*-->\s*$/, "");
  if (skill.startsWith("---")) {
    const end = skill.indexOf("\n---", 3);
    if (end > 0) {
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

// Install/refresh the 7 worrie-* agents into the global pi agents dir
// (~/.pi/agent/agents/) so delegation works in any project with zero
// workspace writes. Used at extension load (missing only) and by /update.
function installGlobalAgents(force = false): number {
  const rulesText = buildSubagentRules(loadWorkspaceRules());
  let installed = 0;
  try {
    mkdirSync(GLOBAL_AGENTS_DIR, { recursive: true });
    for (const [file, spec] of Object.entries(AGENT_SPECS)) {
      const target = join(GLOBAL_AGENTS_DIR, file);
      const content = buildAgentFile(
        spec as any,
        rulesText,
        file.replace(/\.md$/, ""),
      );
      if (force || !existsSync(target) || readFileSync(target, "utf8") !== content) {
        writeFileSync(target, content);
        installed++;
      }
    }
  } catch {
    // read-only global dir — personas without delegation still work
  }
  return installed;
}

// ===================================================================
// Memory templates
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

const PROJECT_MEMORY_TEMPLATE = () => {
  try {
    return readFileSync(
      join(PKG_ROOT, "extensions", "embed", "rules", "project_memory.md"),
      "utf8",
    );
  } catch {
    return "# Project Memory & Context Tracker\n";
  }
};

// ===================================================================
// Memory helpers
// ===================================================================

function logMemory(ctx: any, type: string, message: string): void {
  const file = memPath(type);
  if (!file || !existsSync(file)) {
    ctx.ui.notify(
      `Memory file for "${type}" missing. Run /init first.`,
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
  // ── session start: restore state ──
  pi.on("session_start", async (_event, ctx) => {
    memoryConfig = { promptOnBlock: true, maxEntries: 10 };
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
    installGlobalAgents();
    if (!setupDone()) {
      ctx.ui.setStatus("worrie-status", "[SETUP] not initialized");
    } else if (activePersona) {
      const p = PERSONAS[activePersona];
      ctx.ui.setStatus("worrie-status", p.status);
      savedTools = pi.getActiveTools();
      pi.setActiveTools(p.tools);
    } else {
      ctx.ui.setStatus("worrie-status", "[NORMAL]");
    }
  });

  // ── /init (+ /setup alias): workspace identity + memory/archives only ──
  const initCommand = {
    description:
      "Initialize workspace: workspace.json, memory/, archives/ (rules stay injected, agents stay global)",
    handler: async (_args: unknown, ctx: any) => {
      ctx.ui.setStatus("worrie-status", "[SETUP] initializing...");
      mkdirSync(MEMORY_DIR, { recursive: true });
      mkdirSync(ARCHIVES_DIR, { recursive: true });

      if (!setupDone()) {
        const name = await ctx.ui.input("Enter project name:", "");
        if (!name) {
          ctx.ui.notify("Setup cancelled.", "warning");
          ctx.ui.setStatus("worrie-status", "[NORMAL]");
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

      let created = 0;
      for (const [file, template] of Object.entries(MEMORY_TEMPLATES)) {
        const path = join(MEMORY_DIR, file);
        if (!existsSync(path)) {
          writeFileSync(path, template);
          created++;
        }
      }

      const projPath = join(CONFIG_DIR, "memory", "project_memory.md");
      if (!existsSync(projPath)) {
        writeFileSync(
          projPath,
          readFileSync(
            join(PKG_ROOT, "extensions", "embed", "rules", "project_memory.md"),
            "utf8",
          ),
        );
        created++;
      }

      for (const [file, template] of Object.entries(ARCHIVE_TEMPLATES)) {
        const path = join(ARCHIVES_DIR, file);
        if (!existsSync(path)) {
          writeFileSync(path, template);
          created++;
        }
      }

      // persona agents install globally (~/.pi/agent/agents) — nothing in the
      // workspace except workspace.json + memory + archives
      const installed = installGlobalAgents();

      ctx.ui.setStatus("worrie-status", "[NORMAL]");
      ctx.ui.notify(
        `Initialization complete. workspace.json + ${created} memory/archive file(s). Commands: /a /p /c /d /o /s /r /t /normal /context /error /codebase /clean /archive /obsidian /update`,
        "info",
      );
    },
  };
  pi.registerCommand("init", initCommand);
  pi.registerCommand("setup", { ...initCommand, description: "Alias for /init" });


  // ── persona commands (single-letter) ──
  for (const [name, p] of Object.entries(PERSONAS)) {
    pi.registerCommand(name, {
      description: p.delegating
        ? `${name} persona - delegates to ${p.agent} subagent`
        : `${name} persona - read-only, runs in this session`,
      handler: async (args, ctx) => {
        if (!setupDone()) {
          ctx.ui.notify(
            "Run /init first to initialize the workspace.",
            "warning",
          );
          return;
        }
        const task = (args ?? "").trim();
        if (!task && name !== "a" && name !== "p") {
          ctx.ui.notify(`Usage: /${name} <task>`, "warning");
          return;
        }
        if (!savedTools) savedTools = pi.getActiveTools();
        activePersona = name;
        pi.setActiveTools(p.tools);
        const isAuto = name === "o" && task.toLowerCase().startsWith("auto ");
        ctx.ui.setStatus(
          "worrie-status",
          isAuto ? "[ORCH] automation running" : p.status,
        );
        pi.appendEntry("worrie-persona", { persona: name, at: Date.now() });
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
      ctx.ui.setStatus("worrie-status", "[NORMAL]");
      ctx.ui.notify("Persona mode off. All tools restored.", "info");
    },
  });

  // ── /context — prompt → update project_memory.md ──
  pi.registerCommand("context", {
    description: "Analyze and update project_memory.md with current workflow",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worrie-status", "[MEMORY] updating context...");
      const projPath = join(CONFIG_DIR, "memory", "project_memory.md");
      const msg = await ctx.ui.input(
        "Describe current project state, milestones, or pending items:",
        "",
      );
      if (!msg) {
        ctx.ui.notify("Context update cancelled.", "info");
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
        return;
      }
      if (!existsSync(projPath)) {
        mkdirSync(dirname(projPath), { recursive: true });
        writeFileSync(projPath, PROJECT_MEMORY_TEMPLATE());
      }
      const content = readFileSync(projPath, "utf8");
      const anchor = content.indexOf("\n## 1.");
      const entry = `\n- **${pstNow()}**: ${msg}\n`;
      let next: string;
      if (anchor >= 0) {
        // Insert AFTER the ## 1. header line (LIFO: newest at top of Section 1)
        const headerEnd = anchor + content.slice(anchor).indexOf("\n") + 1;
        next = content.slice(0, headerEnd) + entry + content.slice(headerEnd);
      } else {
        next = content.replace(/\s*$/, "") + "\n" + entry;
      }
      writeFileSync(projPath, next);
      ctx.ui.notify("Project memory updated.", "info");
      ctx.ui.setStatus("worrie-status", "[NORMAL]");
    },
  });

  // ── /error — prompt → update error_memory.md ──
  pi.registerCommand("error", {
    description: "Log an error to error_memory.md",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worrie-status", "[MEMORY] logging error...");
      const file = memPath("err");
      if (!existsSync(file)) {
        ctx.ui.notify("error_memory.md missing. Run /init first.", "warning");
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
        return;
      }
      const msg = await ctx.ui.input("Describe the error:", "");
      if (!msg) {
        ctx.ui.notify("Error logging cancelled.", "info");
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
        return;
      }
      try {
        logMemory(ctx, "err", msg);
      } finally {
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
      }
    },
  });

  // ── /codebase — prompt → update codebase_map.md ──
  pi.registerCommand("codebase", {
    description: "Update codebase_map.md with file descriptions",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worrie-status", "[MEMORY] mapping codebase...");
      const file = memPath("code");
      if (!existsSync(file)) {
        ctx.ui.notify("codebase_map.md missing. Run /init first.", "warning");
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
        return;
      }
      const msg = await ctx.ui.input(
        "Describe file/function structure to map:",
        "",
      );
      if (!msg) {
        ctx.ui.notify("Codebase mapping cancelled.", "info");
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
        return;
      }
      try {
        logMemory(ctx, "code", msg);
      } finally {
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
      }
    },
  });

  // ── /archive — archive overflow entries ──
  pi.registerCommand("archive", {
    description: "Archive overflow memory entries",
    handler: (args, ctx) => {
      ctx.ui.setStatus("worrie-status", "[MEMORY] archiving...");
      try {
        archiveMemory(ctx);
      } finally {
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
      }
    },
  });

  // ── /clean ──
  pi.registerCommand("clean", {
    description:
      "Scan for junk files and debug traces, then remove approved items",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worrie-status", "[CLEAN] scanning...");
      const result: ScanResult = { junk: [], traces: [], empty: [] };
      scanForArtifacts(CWD, result);
      const junk = [...result.junk, ...result.empty];
      if (junk.length === 0 && result.traces.length === 0) {
        ctx.ui.notify("Nothing to clean.", "info");
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
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
      ctx.ui.setStatus("worrie-status", "[NORMAL]");
    },
  });

  // ── /obsidian ──
  pi.registerCommand("obsidian", {
    description:
      "Mirror workspace memory logs and config to your Obsidian vault",
    handler: async (_args, ctx) => {
      if (!setupDone()) {
        ctx.ui.notify(
          "Run /init first to initialize the workspace.",
          "warning",
        );
        return;
      }
      ctx.ui.setStatus("worrie-status", "[OBSIDIAN] syncing...");
      let projectName = readWorkspaceName();

      const projMemory = join(CONFIG_DIR, "memory", "project_memory.md");
      let vault = "";
      let persist = false;
      if (existsSync(projMemory)) {
        const m = readFileSync(projMemory, "utf8").match(
          /\*\*(?:Obsidian )?Vault(?: Path| Root)?\*\*: (.+)/,
        );
        if (m) {
          vault = m[1].trim();
          // placeholder is not a real path — treat as unset and prompt
          if (vault.startsWith("[set after")) vault = "";
        }
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
          ctx.ui.setStatus("worrie-status", "[NORMAL]");
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
        jobs.push([projMemory, join("memory", "project_memory.md")]);
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
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
        return;
      }

      if (persist && existsSync(projMemory)) {
        const content = readFileSync(projMemory, "utf8");
        const line = `- **Vault Root**: ${vault}`;
        if (/^\s*- \*\*(?:Obsidian )?Vault(?: Path| Root)?\*\*: .+$/m.test(content)) {
          // replace existing placeholder/entry in place (uveworkflow template)
          writeFileSync(
            projMemory,
            content.replace(
              /^(\s*- \*\*(?:Obsidian )?Vault(?: Path| Root)?\*\*: ).+$/m,
              `$1${vault}`,
            ),
          );
        } else {
          // new template roots live in §3 Important Details
          const anchor = content.indexOf("\n## 3.");
          const next =
            anchor >= 0
              ? content.slice(0, anchor) + `${line}\n` + content.slice(anchor)
              : content.replace(/\s*$/, "") + `\n${line}\n`;
          writeFileSync(projMemory, next);
        }
      }

      ctx.ui.notify(
        `Obsidian sync complete. ${copied.length} file(s) mirrored to ${dest}\n${copied.join("\n")}`,
        "info",
      );
      ctx.ui.setStatus("worrie-status", "[NORMAL]");
    },
  });

  // ── /update — fetch uveworkflow templates ──
  pi.registerCommand("update", {
    description:
      "Fetch latest templates from uveworkflow repo and update source files",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worrie-status", "[UPDATE] fetching...");
      const tmpDir = join(CWD, ".pi", ".update-tmp");
      try {
        ctx.ui.notify("Cloning uveworkflow repo...", "info");
        execSync(
          `git clone --depth 1 https://github.com/worriee/uveworkflow "${tmpDir}"`,
          { timeout: 30000, stdio: "pipe" },
        );

        const srcRules = join(tmpDir, ".pi", "rules");
        const srcSkills = join(tmpDir, ".pi", "skills");
        const srcMemory = join(tmpDir, ".pi", "memory");
        const srcArchives = join(tmpDir, ".pi", "archives");

        const destRules = join(PKG_ROOT, "extensions", "embed", "rules");
        const destSkills = join(PKG_ROOT, "extensions", "embed", "skills");
        const destMemory = join(PKG_ROOT, "templates", "memory");
        const destArchives = join(PKG_ROOT, "templates", "archives");

        let updated = 0;

        // Copy rules
        if (existsSync(srcRules)) {
          mkdirSync(destRules, { recursive: true });
          for (const f of readdirSync(srcRules)) {
            const src = join(srcRules, f);
            const dst = join(destRules, f);
            if (statSync(src).isFile()) {
              writeFileSync(dst, readFileSync(src));
              updated++;
            }
          }
        }

        // Copy skills
        if (existsSync(srcSkills)) {
          mkdirSync(destSkills, { recursive: true });
          for (const skill of readdirSync(srcSkills)) {
            const skillDir = join(srcSkills, skill);
            if (!statSync(skillDir).isDirectory()) continue;
            const destSkillDir = join(destSkills, skill);
            mkdirSync(destSkillDir, { recursive: true });
            for (const f of readdirSync(skillDir)) {
              const src = join(skillDir, f);
              const dst = join(destSkillDir, f);
              if (statSync(src).isFile()) {
                writeFileSync(dst, readFileSync(src));
                updated++;
              }
            }
          }
        }

        // Copy memory templates
        if (existsSync(srcMemory)) {
          mkdirSync(destMemory, { recursive: true });
          for (const f of readdirSync(srcMemory)) {
            const src = join(srcMemory, f);
            const dst = join(destMemory, f);
            if (statSync(src).isFile()) {
              writeFileSync(dst, readFileSync(src));
              updated++;
            }
          }
        }

        // Copy archive templates
        if (existsSync(srcArchives)) {
          mkdirSync(destArchives, { recursive: true });
          for (const f of readdirSync(srcArchives)) {
            const src = join(srcArchives, f);
            const dst = join(destArchives, f);
            if (statSync(src).isFile()) {
              writeFileSync(dst, readFileSync(src));
              updated++;
            }
          }
        }

        // Regenerate the global worrie-* agents from refreshed embed sources
        // so delegation in any project picks up the new rules+skills.
        updated += installGlobalAgents(true);

        ctx.ui.notify(
          `Update complete. ${updated} file(s) updated from uveworkflow.`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Update failed: ${err}`, "error");
      } finally {
        // Clean temp dir
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best effort
        }
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
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
        ctx.ui.setStatus("worrie-subagent", "[BLOCKED] ask/plan is read-only");
      }
      return {
        block: true,
        reason: `${activePersona} is read-only. Use /normal or a write-capable persona.`,
      };
    }
  });

  // ── persona prompt injection ──
  pi.on("before_agent_start", async (event, ctx) => {
    // always inject rules (upstream + flag map); persona prompt rides on top
    if (activePersona) {
      return {
        systemPrompt:
          event.systemPrompt +
          "\n\n" +
          INJECTED_RULES +
          "\n\n" +
          PERSONAS[activePersona].prompt,
      };
    }
    return { systemPrompt: event.systemPrompt + "\n\n" + INJECTED_RULES };
  });

  // ── turn end: restore after delegation ──
  pi.on("agent_settled", async (_event, ctx) => {
    if (activePersona && PERSONAS[activePersona].delegating) {
      activePersona = null;
      if (savedTools) {
        pi.setActiveTools(savedTools);
        savedTools = null;
      }
      ctx.ui.setStatus("worrie-status", "[NORMAL]");
    }
  });
}
