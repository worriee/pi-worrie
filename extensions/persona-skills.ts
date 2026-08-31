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
// Rules source (pi rules vs AGENTS.md/CLAUDE.md)
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

function applyRulesSource(source: RulesSource): boolean {
  if (source !== "pi") {
    // ponytail: pi loads AGENTS.override.md > AGENTS.md > CLAUDE.md, first match wins.
    // Selecting AGENTS.md/CLAUDE.md must NOT create an override — it would shadow the real file.
    // Delete any existing override so pi falls back to the real file natively.
    try {
      if (existsSync(OVERRIDE_FILE)) rmSync(OVERRIDE_FILE);
      return true;
    } catch {
      return false;
    }
  }
  // Default rules: pointer to the generated .pi/rules files when they exist
  // (the AI then follows the FULL rules, incl. the appended pi-worrie command
  // sections). Fall back to embedded slim sections for old workspaces whose
  // files were generated before /setup wrote them.
  const cli = join(CONFIG_DIR, "rules", ".clinerules");
  const sys = join(CONFIG_DIR, "rules", "system_instructions.md");
  const pointer =
    "# Rules Override (pi-worrie)\n\nFollow the rules inside the .pi folder strictly:\n- Read `.pi/rules/.clinerules`\n- Read `.pi/rules/system_instructions.md`\n";
  let content: string;
  if (existsSync(cli) && existsSync(sys)) {
    content = pointer;
  } else {
    const rules = buildSubagentRules(loadWorkspaceRules()).trim();
    content = rules ? `# Rules Override (pi-worrie)\n\n${rules}` : pointer;
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
// Agent file construction (written by /setup)
// ===================================================================

function extensionDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return __dirname;
  }
}

const PKG_ROOT = join(extensionDir(), "..");

function loadWorkspaceRules(): string {
  try {
    const cli = readFileSync(join(PKG_ROOT, "templates", "rules", ".clinerules"), "utf8");
    const sys = readFileSync(
      join(PKG_ROOT, "templates", "rules", "system_instructions.md"),
      "utf8",
    );
    return `${cli}\n\n---\n\n${sys}`;
  } catch {
    return "";
  }
}

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

function buildAgentFile(
  spec: { skill: string; tools: string; memoryProtocol?: string },
  rulesText: string,
  agentName: string,
): string {
  const skillPath = join(PKG_ROOT, "templates", "skills", spec.skill, "SKILL.md");
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

// ===================================================================
// Memory helpers
// ===================================================================

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

function resolveEntry(ctx: any, id: string): void {
  const idUpper = id.toUpperCase();
  let found = false;
  for (const [type, t] of Object.entries(MEMORY_TYPES)) {
    if (!t.prefix) continue;
    const file = memPath(type);
    if (!file || !existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`### [${idUpper}] `));
    if (start === -1) continue;
    const sec1End = lines.findIndex(
      (l, i) => i > start && l.startsWith("## 2."),
    );
    if (sec1End === -1) continue;
    let end = lines.findIndex((l, i) => i > start && /^#{3,4} \[/.test(l));
    if (end === -1) end = sec1End;
    const block = lines.slice(start, end);
    const title = block[0].replace(`### [${idUpper}] `, "");
    block[0] = `### [RESOLVED] ${title} (${idUpper})`;
    let sec2 = lines.findIndex((l, i) => i > start && l.startsWith("## 2."));
    if (sec2 === -1) sec2 = sec1End;
    let ins = sec2 + 1;
    while (
      ins < lines.length &&
      (lines[ins].trim() === "" ||
        lines[ins].startsWith("_") ||
        lines[ins].startsWith(">"))
    )
      ins++;
    lines.splice(start, end - start);
    lines.splice(ins, 0, ...block, "");
    writeFileSync(file, lines.join("\n"));
    ctx.ui.notify(`Resolved ${idUpper} → Section 2 (${t.file})`, "info");
    found = true;
    break;
  }
  if (!found)
    ctx.ui.notify(`Entry ${idUpper} not found in active section.`, "warning");
}

function buildTable(ctx: any, type: string, flag: string): void {
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
    /^#{3,4} \[(RESOLVED\] |[A-Z]+(?:-[A-Z]+)*-\d+)\]/.test(b),
  );
  let list = entries;
  if (flag === "--active")
    list = entries.filter((b) => !b.startsWith("### [RESOLVED]"));
  else if (flag === "--resolved")
    list = entries.filter((b) => b.startsWith("### [RESOLVED]"));
  else if (flag === "--all") list = entries;
  else if (flag === "--count") {
    const active = entries.filter(
      (b) => !b.startsWith("### [RESOLVED]"),
    ).length;
    const resolved = entries.filter((b) =>
      b.startsWith("### [RESOLVED]"),
    ).length;
    ctx.ui.notify(
      `${type}: open ${active}  resolved ${resolved}  total ${active + resolved}`,
      "info",
    );
    return;
  }
  if (list.length === 0) {
    ctx.ui.notify(`No entries for ${type}.`, "info");
    return;
  }
  const rows = list.map((b) => {
    const head = b.split("\n")[0];
    const status = b.startsWith("### [RESOLVED]") ? "RESOLVED" : "OPEN";
    const match = head.match(/^### \[([^\]]+)\] (.+)/);
    const id = match ? `[${match[1]}]` : head.slice(0, 12).padEnd(12);
    const title = match
      ? match[2].slice(0, 40).padEnd(40)
      : head.slice(12).padEnd(40);
    return `| ${id} | ${title} | ${status} |`;
  });
  const header = `| ID | Title | Status |\n|----|-------|--------|`;
  ctx.ui.notify(
    `/m list ${type} (${list.length} entries)\n${header}\n${rows.join("\n")}`,
    "info",
  );
}

function buildCrossFileTable(ctx: any, flag: string): void {
  const allEntries: Array<{
    file: string;
    id: string;
    title: string;
    status: string;
  }> = [];
  for (const [type, t] of Object.entries(MEMORY_TYPES)) {
    if (!t.prefix) continue;
    const file = memPath(type);
    if (!file || !existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    const raw = content
      .split("\n###")
      .slice(1)
      .map((b) => "###" + b);
    const blocks = raw.filter((b) => /^#{3,4} \[/.test(b));
    const entries = blocks.filter((b) =>
      /^#{3,4} \[(RESOLVED\] |[A-Z]+(?:-[A-Z]+)*-\d+)\]/.test(b),
    );
    let list = entries;
    if (flag === "--active")
      list = entries.filter((b) => !b.startsWith("### [RESOLVED]"));
    else if (flag === "--resolved")
      list = entries.filter((b) => b.startsWith("### [RESOLVED]"));
    else if (flag === "--count") {
      const active = entries.filter(
        (b) => !b.startsWith("### [RESOLVED]"),
      ).length;
      const resolved = entries.filter((b) =>
        b.startsWith("### [RESOLVED]"),
      ).length;
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
  const rows = allEntries
    .slice(0, 20)
    .map(
      (e) =>
        `| ${e.file.padEnd(20)} | ${e.id.padEnd(10)} | ${e.title.padEnd(35)} | ${e.status} |`,
    );
  const header = `| File | ID | Title | Status |\n|------|----|-------|--------|`;
  const extra =
    allEntries.length > 20 ? `\n... and ${allEntries.length - 20} more` : "";
  ctx.ui.notify(
    `/m list (${flag}) ${allEntries.length} entries total${extra}\n${header}\n${rows.join("\n")}`,
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
    `[BLOCK] prompt ${memoryConfig.promptOnBlock ? "ON" : "OFF"}\n[ARCHIVE] threshold ${memoryConfig.maxEntries}`,
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
    const saved = readRulesSource();
    if (saved) applyRulesSource(saved);
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

  // ── /setup ──
  pi.registerCommand("setup", {
    description:
      "Initialize workspace: workspace.json, memory files, agent files",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worrie-status", "[SETUP] initializing...");
      mkdirSync(MEMORY_DIR, { recursive: true });
      mkdirSync(AGENTS_DIR, { recursive: true });
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
      const projPath = join(CONFIG_DIR, "rules", "project_memory.md");
      if (!existsSync(projPath)) {
        mkdirSync(dirname(projPath), { recursive: true });
        writeFileSync(projPath, PROJECT_MEMORY_TEMPLATE);
        created++;
      }

      // generate rules beside project_memory.md (uveworkflow layout) so the
      // default /rules override pointer resolves. Never overwrites existing.
      for (const f of [".clinerules", "system_instructions.md"]) {
        const src = join(PKG_ROOT, "templates", "rules", f);
        const dst = join(CONFIG_DIR, "rules", f);
        if (existsSync(src) && !existsSync(dst)) {
          writeFileSync(dst, readFileSync(src));
          created++;
        }
      }

      for (const [file, template] of Object.entries(ARCHIVE_TEMPLATES)) {
        const path = join(ARCHIVES_DIR, file);
        if (!existsSync(path)) {
          writeFileSync(path, template);
          created++;
        }
      }

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

      ctx.ui.setStatus("worrie-status", "[NORMAL]");
      ctx.ui.notify(
        `Setup complete. ${agents} agent(s), ${created} memory/archive file(s). Commands: /a /p /c /d /o /s /r /t /normal /context /error /codebase /m /ml /clean /obsidian /update /rules`,
        "info",
      );
    },
  });

  // ── /init (init workspace.json only) ──
  pi.registerCommand("init", {
    description: "Initialize workspace.json only",
    handler: async (_args, ctx) => {
      ctx.ui.setStatus("worrie-status", "[INIT] setting up...");
      mkdirSync(CONFIG_DIR, { recursive: true });
      if (!setupDone()) {
        const name = await ctx.ui.input("Enter project name:", "");
        if (!name) {
          ctx.ui.notify("Init cancelled.", "warning");
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
        ctx.ui.notify(
          `WORKSPACE ALREADY INITIALIZED: ${readWorkspaceName()}`,
          "info",
        );
      }
      ctx.ui.setStatus("worrie-status", "[NORMAL]");
    },
  });

  // ── persona commands (single-letter) ──
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
      const projPath = join(CONFIG_DIR, "rules", "project_memory.md");
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
        writeFileSync(projPath, PROJECT_MEMORY_TEMPLATE);
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
        ctx.ui.notify("error_memory.md missing. Run /setup first.", "warning");
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
        ctx.ui.notify("codebase_map.md missing. Run /setup first.", "warning");
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

  // ── /m — unified memory command ──
  pi.registerCommand("m", {
    description: "Memory: list, resolve, config",
    getArgumentCompletions: (prefix: string) => {
      const text = prefix ?? "";
      // (applyCompletion: beforePrefix + item.value, prefix = full arg text) then auto-submits.
      // Completing a 2nd+ token wipes earlier tokens (/m list err -> /m err). Only
      // single-token completions are safe.
      if (text.includes(" ")) return null;
      const current = text.split(/\s+/).pop() ?? "";

      const filter = (
        items: { value: string; label: string; description?: string }[],
        tok: string,
      ) => {
        const f = items.filter((i) => i.value.startsWith(tok));
        return f.length > 0 ? f : null;
      };

      return filter(
        [
          { value: "list", label: "list", description: "List memory entries" },
          {
            value: "resolve",
            label: "resolve",
            description: "Resolve entry by ID",
          },
          { value: "config", label: "config", description: "Show/set config" },
        ],
        current,
      );
    },
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const sub = parts[0];
      const rest = parts.slice(1);

      // /m list [type] [--flags]
      if (sub === "list") {
        const type = rest[0];
        const flag = rest[1] ?? "--active";
        if (!type || !MEMORY_TYPES[type]) {
          buildCrossFileTable(ctx, flag);
          return;
        }
        buildTable(ctx, type, flag);
        return;
      }

      // /m resolve <id>
      if (sub === "resolve") {
        const id = (rest[0] ?? "").toUpperCase();
        if (!id) {
          ctx.ui.notify(
            "Usage: /m resolve <ERR-XXX | SEC-XXX | REV-XXX | TEST-XXX>",
            "warning",
          );
          return;
        }
        ctx.ui.setStatus("worrie-status", "[MEMORY] resolving...");
        try {
          resolveEntry(ctx, id);
        } finally {
          ctx.ui.setStatus("worrie-status", "[NORMAL]");
        }
        return;
      }

      // /m config [key] [value]
      if (sub === "config") {
        const key = rest[0];
        const value = rest[1];
        if (!key) {
          showConfig(ctx);
          return;
        }
        if (
          key === "promptOnBlock" &&
          (value === "true" || value === "false")
        ) {
          memoryConfig.promptOnBlock = value === "true";
          pi.appendEntry("worrie-memory-config", { ...memoryConfig });
          ctx.ui.notify(
            `promptOnBlock ${memoryConfig.promptOnBlock ? "ON" : "OFF"}`,
            "info",
          );
          return;
        }
        if (key === "maxEntries" && /^\d+$/.test(value ?? "")) {
          memoryConfig.maxEntries = parseInt(value!, 10);
          pi.appendEntry("worrie-memory-config", { ...memoryConfig });
          ctx.ui.notify(
            `Archive threshold set to ${memoryConfig.maxEntries}`,
            "info",
          );
          return;
        }
        if (key === "reset") {
          memoryConfig = { promptOnBlock: true, maxEntries: 10 };
          pi.appendEntry("worrie-memory-config", { ...memoryConfig });
          ctx.ui.notify("Memory config reset to defaults", "info");
          return;
        }
        ctx.ui.notify(
          "Usage: /m config [promptOnBlock|maxEntries|reset] [value]",
          "warning",
        );
        return;
      }

      // /m <type> "message" logging was removed — the AI logs memory entries
      // itself with its own tracking IDs (uveworkflow style).
      ctx.ui.notify(
        "Usage: /m list [type] [--active|--resolved|--all|--count] | /m resolve <ID> | /m config [key] [value]",
        "warning",
      );
    },
  });

  // ── /ml — list memory entries (shorthand for /m list) ──
  pi.registerCommand("ml", {
    description: "View memory entries as table",
    getArgumentCompletions: (prefix: string) => {
      const text = prefix ?? "";
      // on Enter, so only single-token completions are safe.
      if (text.includes(" ")) return null;
      const current = text.split(/\s+/).pop() ?? "";

      const types = Object.entries(MEMORY_TYPES).map(([key, t]) => ({
        value: key,
        label: key,
        description: `${t.title} -> .pi/${t.file}`,
      }));

      const f = types.filter((i) => i.value.startsWith(current));
      return f.length > 0 ? f : null;
    },
    handler: (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const type = parts[0];
      const flag = parts[1] ?? "--active";
      if (!MEMORY_TYPES[type]) {
        buildCrossFileTable(ctx, flag);
        return;
      }
      buildTable(ctx, type, flag);
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
          "Run /setup first to initialize the workspace.",
          "warning",
        );
        return;
      }
      ctx.ui.setStatus("worrie-status", "[OBSIDIAN] syncing...");
      let projectName = readWorkspaceName();

      const projMemory = join(CONFIG_DIR, "rules", "project_memory.md");
      let vault = "";
      let persist = false;
      if (existsSync(projMemory)) {
        const m = readFileSync(projMemory, "utf8").match(
          /\*\*(?:Obsidian )?Vault Path\*\*: (.+)/,
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
        ctx.ui.setStatus("worrie-status", "[NORMAL]");
        return;
      }

      if (persist && existsSync(projMemory)) {
        const content = readFileSync(projMemory, "utf8");
        const line = `- **Vault Path**: ${vault}`;
        if (/^\s*- \*\*(?:Obsidian )?Vault Path\*\*: .+$/m.test(content)) {
          // replace existing placeholder/entry in place (uveworkflow template)
          writeFileSync(
            projMemory,
            content.replace(
              /^(\s*- \*\*(?:Obsidian )?Vault Path\*\*: ).+$/m,
              `$1${vault}`,
            ),
          );
        } else {
          const anchor = content.indexOf("\n## 1.");
          const next =
            anchor >= 0
              ? content.slice(0, anchor) + `\n${line}\n` + content.slice(anchor)
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
        const srcWorkspace = join(tmpDir, ".pi", "workspace.json");

        const destRules = join(PKG_ROOT, "templates", "rules");
        const destSkills = join(PKG_ROOT, "templates", "skills");
        const destMemory = join(PKG_ROOT, "templates", "memory");
        const destArchives = join(PKG_ROOT, "templates", "archives");
        const destWorkspace = join(PKG_ROOT, "templates", "workspace.json");

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

        // Copy workspace template
        if (existsSync(srcWorkspace)) {
          writeFileSync(destWorkspace, readFileSync(srcWorkspace));
          updated++;
        }

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

  // ── /rules — choose rules source ──
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
          `Could not apply rules for ${chosen.label}.`,
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
    if (activePersona) {
      return {
        systemPrompt:
          event.systemPrompt + "\n\n" + PERSONAS[activePersona].prompt,
      };
    }
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
