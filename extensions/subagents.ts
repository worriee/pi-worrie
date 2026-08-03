/**
 * subagents extension
 * c: worrie
 *
 * Spawns agent files (.pi/agents/*.md, ~/.pi/agent/agents/*.md) as
 * isolated child pi processes. Concept inspired by pi-subagents.
 *
 * Modes:
 *   - single:   { agent, task }
 *   - parallel: { tasks: [{ agent, task }, ...] }
 *   - chain:    { chain: [{ agent, task, approval?, label? }, ...] }
 *
 * All modes support async: true (background). Chains support per-step
 * approval dialogs (Continue / Re-run / Abort) for gated workflows
 * like the 11-stage pipeline.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ===================================================================
// Constants
// ===================================================================

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_DEPTH = 3;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_PREVIOUS_BYTES = 8 * 1024;
const MAX_RETRIES_PER_STEP = 5;
const TRUST_FILE = path.join(".pi", "subagents-trust.json");

// ===================================================================
// Types
// ===================================================================

interface AgentConfig {
  name: string;
  description: string;
  tools: string[];
  model?: string;
  systemPrompt: string;
  source: "user" | "project";
}

interface StepSpec {
  agent: string;
  task: string;
  approval?: boolean;
  label?: string;
  cwd?: string;
}

interface RunResult {
  agent: string;
  source: string;
  task: string;
  label?: string;
  exitCode: number;
  output: string;
  error?: string;
  step?: number;
}

interface RunState {
  id: string;
  mode: "single" | "parallel" | "chain";
  status: "running" | "waiting-approval" | "done" | "failed" | "aborted";
  agent: string;
  startedAt: number;
  results: RunResult[];
  currentStep?: number;
  totalSteps?: number;
  latestText: string;
  children: Set<ChildProcess>;
  completion?: Promise<void>;
  resolveCompletion?: () => void;
}

// ===================================================================
// State
// ===================================================================

const runs = new Map<string, RunState>();
let runCounter = 0;
let sessionTrusted = false;

// ===================================================================
// Agent discovery
// ===================================================================

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = (frontmatter.tools ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools,
      model: frontmatter.model,
      systemPrompt: body,
      source,
    });
  }
  return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function discoverAgents(cwd: string): { agents: AgentConfig[]; projectDir: string | null } {
  const projectDir = findProjectAgentsDir(cwd);
  const userDir = path.join(getAgentDir(), "agents");
  const map = new Map<string, AgentConfig>();
  for (const a of loadAgentsFromDir(userDir, "user")) map.set(a.name, a);
  if (projectDir) {
    for (const a of loadAgentsFromDir(projectDir, "project")) map.set(a.name, a);
  }
  return { agents: Array.from(map.values()), projectDir };
}

// ===================================================================
// Trust
// ===================================================================

function trustAlways(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(process.cwd(), TRUST_FILE), "utf8"));
    return data.mode === "always";
  } catch {
    return false;
  }
}

function writeTrustAlways(): void {
  try {
    fs.mkdirSync(path.join(process.cwd(), ".pi"), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), TRUST_FILE), JSON.stringify({ mode: "always" }, null, 2));
  } catch {
    // best effort
  }
}

// ===================================================================
// Child process spawn
// ===================================================================

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

function currentDepth(): number {
  const raw = process.env.PI_WORRIE_DEPTH;
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function runChild(
  agent: AgentConfig,
  task: string,
  cwd: string,
  run: RunState,
  signal: AbortSignal | undefined,
  onOutput: (text: string) => void,
): Promise<{ exitCode: number; output: string; error?: string }> {
  const args = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  const taskPrompt = `${task}\n\nOUTPUT CONTRACT: End with a concise summary only: what was done, files changed, memory entries written (IDs). Keep the final response short. No full logs.`;
  const systemPrompt = `${agent.systemPrompt}\n\nTask: ${taskPrompt}`;

  // system prompt via temp file
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-worrie-sub-"));
  const tmpFile = path.join(tmpDir, "prompt.md");
  await fs.promises.writeFile(tmpFile, systemPrompt, { encoding: "utf-8", mode: 0o600 });
  args.push("--append-system-prompt", tmpFile);
  args.push(`Task: ${task}`);

  const invocation = getPiInvocation(args);
  let messages: any[] = [];
  let stderr = "";

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_WORRIE_DEPTH: String(currentDepth() + 1) },
      });
      run.children.add(proc);

      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === "message_end" && event.message) {
          messages.push(event.message);
          if (event.message.role === "assistant") {
            for (const part of event.message.content ?? []) {
              if (part.type === "text") onOutput(part.text);
            }
          }
        }
        if (event.type === "tool_result_end" && event.message) {
          messages.push(event.message);
        }
      };
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore
          }
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    // final output = last assistant text
    let finalText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        for (const part of msg.content ?? []) {
          if (part.type === "text" && part.text.trim()) {
            finalText = part.text;
            break;
          }
        }
        if (finalText) break;
      }
    }
    const output = Buffer.byteLength(finalText, "utf8") > MAX_OUTPUT_BYTES
      ? `${finalText.slice(0, MAX_OUTPUT_BYTES)}\n\n[Output truncated]`
      : finalText;
    return { exitCode, output, error: exitCode !== 0 ? (stderr || "(no stderr)").slice(0, 2000) : undefined };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
      fs.rmdirSync(tmpDir);
    } catch {
      // ignore
    }
  }
}

// ===================================================================
// Widget + notifications
// ===================================================================

function widgetLine(run: RunState): string {
  if (run.mode === "chain") {
    const step = run.currentStep ?? 1;
    const total = run.totalSteps ?? 1;
    return `${run.status === "running" ? "RUN" : run.status.toUpperCase()} chain ${step}/${total}: ${run.agent}`;
  }
  if (run.mode === "parallel") {
    const done = run.results.length;
    return `RUN parallel ${done}/${run.totalSteps ?? "?"}: ${run.agent}`;
  }
  return `${run.status === "running" ? "RUN" : run.status.toUpperCase()} ${run.agent}`;
}

function refreshWidget(ui: any): void {
  const active = Array.from(runs.values()).filter((r) => r.status === "running" || r.status === "waiting-approval");
  if (active.length === 0) {
    ui?.setWidget("worrie-subagents", undefined);
    return;
  }
  ui?.setWidget("worrie-subagents", active.map(widgetLine));
}

function finishRun(run: RunState, ui: any): void {
  run.resolveCompletion?.();
  refreshWidget(ui);
}

// ===================================================================
// Chain execution
// ===================================================================

async function executeChain(
  pi: ExtensionAPI,
  steps: StepSpec[],
  agents: AgentConfig[],
  cwd: string,
  ui: any,
  signal: AbortSignal | undefined,
  run: RunState,
): Promise<void> {
  run.totalSteps = steps.length;
  let previous = "";
  let stepIndex = 0;
  let loopCount = 0;
  let lastStep = "";

  while (stepIndex < steps.length) {
    const step = steps[stepIndex];
    const agent = agents.find((a) => a.name === step.agent);
    run.agent = step.agent;
    run.currentStep = stepIndex + 1;

    if (!agent) {
      run.results.push({
        agent: step.agent,
        source: "unknown",
        task: step.task,
        label: step.label,
        exitCode: 1,
        output: "",
        error: `Unknown agent "${step.agent}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
        step: stepIndex + 1,
      });
      run.status = "failed";
      refreshWidget(ui);
      return;
    }

    // approval gate BEFORE running this step (skip for step 1)
    if (step.approval && stepIndex > 0) {
      run.status = "waiting-approval";
      refreshWidget(ui);
      let choice = "Continue";
      if (ui?.hasUI && !ui.hasUI()) {
        choice = "Continue"; // headless: auto-continue
      } else if (ui) {
        try {
          choice =
            (await ui.select(
              `Approve stage ${stepIndex + 1}/${steps.length}?`,
              ["Continue", "Re-run previous stage", "Abort chain"],
            )) ?? "Abort chain";
        } catch {
          choice = "Continue";
        }
      }
      run.status = "running";
      refreshWidget(ui);

      if (choice === "Abort chain") {
        run.status = "aborted";
        finishRun(run, ui);
        ui?.notify("Chain aborted by user.", "info");
        return;
      }
      if (choice === "Re-run previous stage") {
        if (loopCount >= MAX_RETRIES_PER_STEP) {
          run.status = "failed";
          run.results.push({
            agent: lastStep,
            source: "unknown",
            task: "",
            label: undefined,
            exitCode: 1,
            output: "",
            error: `Max re-runs (${MAX_RETRIES_PER_STEP}) reached. Chain halted.`,
          });
          finishRun(run, ui);
          return;
        }
        loopCount++;
        continue; // re-run previous step
      }
      loopCount = 0;
    }

    lastStep = step.agent;
    const task = step.task.replace(/\{previous\}/g, previous);
    ui?.setWidget("worrie-subagents", [`RUN chain ${stepIndex + 1}/${steps.length}: ${step.agent}...`]);

    const result = await runChild(agent, task, step.cwd ?? cwd, run, signal, (text) => {
      run.latestText = text;
    });

    const summary = result.output.slice(0, 400);
    run.results.push({
      agent: step.agent,
      source: agent.source,
      task: step.task,
      label: step.label,
      exitCode: result.exitCode,
      output: result.output,
      error: result.error,
      step: stepIndex + 1,
    });
    previous = Buffer.byteLength(result.output, "utf8") > MAX_PREVIOUS_BYTES
      ? `${result.output.slice(0, MAX_PREVIOUS_BYTES)}\n\n[Previous output truncated]`
      : result.output;

    if (result.exitCode !== 0) {
      run.status = "failed";
      ui?.notify(`Chain step ${stepIndex + 1} (${step.agent}) failed: ${result.error ?? "unknown error"}`, "error");
      finishRun(run, ui);
      return;
    }

    ui?.notify(`Step ${stepIndex + 1}/${steps.length} ${step.agent} done. ${summary.split("\n")[0]}`, "info");
    stepIndex++;
  }

  run.status = "done";
  finishRun(run, ui);
}

// ===================================================================
// Parallel execution
// ===================================================================

async function executeParallel(
  tasks: { agent: string; task: string; cwd?: string }[],
  agents: AgentConfig[],
  cwd: string,
  ui: any,
  signal: AbortSignal | undefined,
  run: RunState,
): Promise<void> {
  run.totalSteps = tasks.length;
  const results: RunResult[] = new Array(tasks.length);
  let nextIndex = 0;
  const workers = new Array(Math.min(MAX_CONCURRENCY, tasks.length)).fill(null).map(async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= tasks.length) return;
      const t = tasks[idx];
      const agent = agents.find((a) => a.name === t.agent);
      run.agent = t.agent;
      if (!agent) {
        results[idx] = {
          agent: t.agent,
          source: "unknown",
          task: t.task,
          exitCode: 1,
          output: "",
          error: `Unknown agent "${t.agent}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
        };
        continue;
      }
      const r = await runChild(agent, t.task, t.cwd ?? cwd, run, signal, (text) => {
        run.latestText = text;
      });
      results[idx] = {
        agent: t.agent,
        source: agent.source,
        task: t.task,
        exitCode: r.exitCode,
        output: r.output,
        error: r.error,
      };
      refreshWidget(ui);
    }
  });
  await Promise.all(workers);
  run.results = results;
  run.status = results.some((r) => r.exitCode !== 0) ? "failed" : "done";
  finishRun(run, ui);
}

// ===================================================================
// Tool definition helpers
// ===================================================================

function buildResultContent(run: RunState): string {
  if (run.mode === "single") {
    const r = run.results[0];
    return r?.error ? `Agent ${r.agent} failed: ${r.error}` : (r?.output || "(no output)");
  }
  if (run.mode === "parallel") {
    const parts = run.results.map((r) => {
      const status = r.exitCode === 0 ? "done" : "failed";
      return `### [${r.agent}] ${status}\n${(r.error ?? r.output).slice(0, 2000)}`;
    });
    return parts.join("\n\n---\n\n");
  }
  // chain
  const lines = run.results.map((r) => {
    const label = r.label ?? `${r.step ?? "?"}`;
    const icon = r.exitCode === 0 ? "ok" : "FAILED";
    const first = (r.output || r.error || "").split("\n")[0] ?? "";
    return `- step ${label} ${r.agent} [${icon}] ${first.slice(0, 200)}`;
  });
  const last = run.results[run.results.length - 1];
  return `${lines.join("\n")}\n\n${last?.exitCode === 0 ? last.output.slice(0, 8000) : `Chain failed at step ${last?.step}: ${last?.error ?? "unknown"}`}`;
}

// ===================================================================
// Extension
// ===================================================================

export default function (pi: ExtensionAPI) {
  let ui: any = null;

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    sessionTrusted = trustAlways();
  });

  pi.on("session_shutdown", () => {
    for (const run of runs.values()) {
      for (const proc of run.children) {
        try {
          proc.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
    runs.clear();
  });

  // ── subagent tool ──
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate tasks to specialized subagents with isolated context.",
      "Modes: single (agent + task), parallel (tasks array), chain (sequential steps, {previous} = prior step output).",
      "Set async: true to run in the background and keep working; collect results later with subagent_wait.",
      "Chain steps: set approval: true to pause with a user dialog between steps (Continue / Re-run / Abort).",
      "Agents live in project .pi/agents or user agents dir.",
    ].join(" "),
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
      task: Type.Optional(Type.String({ description: "Task for the agent (single mode)" })),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String(),
            task: Type.String(),
            cwd: Type.Optional(Type.String()),
          }),
          { description: "Parallel tasks" },
        ),
      ),
      chain: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String(),
            task: Type.String(),
            approval: Type.Optional(Type.Boolean({ description: "Pause for user approval before this step" })),
            label: Type.Optional(Type.String({ description: "Step label, e.g. '3/11: TEST'" })),
            cwd: Type.Optional(Type.String()),
          }),
          { description: "Sequential chain steps" },
        ),
      ),
      async: Type.Optional(Type.Boolean({ description: "Run in background, return immediately" })),
      cwd: Type.Optional(Type.String()),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      ui = ctx.ui;
      const discovery = discoverAgents(ctx.cwd);
      const agents = discovery.agents;
      const cwd = params.cwd ?? ctx.cwd;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      if (modeCount !== 1) {
        return {
          content: [
            {
              type: "text",
              text: `Provide exactly one mode. Available agents: ${agents.map((a) => a.name).join(", ") || "none"}`,
            },
          ],
          details: {},
        };
      }

      // depth guard
      if (currentDepth() >= MAX_DEPTH) {
        return {
          content: [{ type: "text", text: `Max subagent depth (${MAX_DEPTH}) reached. Refusing to spawn deeper.` }],
          details: {},
        };
      }

      // trust gate for project agents
      const requestedNames = new Set<string>();
      if (params.chain) for (const s of params.chain) requestedNames.add(s.agent);
      if (params.tasks) for (const t of params.tasks) requestedNames.add(t.agent);
      if (params.agent) requestedNames.add(params.agent);
      const usesProjectAgents = Array.from(requestedNames).some((n) =>
        agents.find((a) => a.name === n)?.source === "project",
      );
      if (usesProjectAgents && discovery.projectDir && !sessionTrusted) {
        let choice = "Cancel";
        if (ctx.hasUI) {
          choice =
            (await ctx.ui.select(
              "Run project agents?",
              ["Trust once (this session)", "Trust always (this project)", "Cancel"],
            )) ?? "Cancel";
        }
        if (choice === "Cancel") {
          return {
            content: [{ type: "text", text: "Canceled: project agents not approved." }],
            details: {},
          };
        }
        if (choice === "Trust always (this project)") {
          writeTrustAlways();
        }
        sessionTrusted = true;
      }

      const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      runCounter++;
      const id = `run-${Date.now().toString(36)}-${runCounter}`;
      const run: RunState = {
        id,
        mode,
        status: "running",
        agent: hasChain ? (params.chain![0]?.agent ?? "chain") : hasTasks ? "parallel" : params.agent!,
        startedAt: Date.now(),
        results: [],
        latestText: "",
        children: new Set(),
      };
      run.completion = new Promise<void>((resolve) => {
        run.resolveCompletion = resolve;
      });
      runs.set(id, run);
      refreshWidget(ui);

      const start = async () => {
        if (hasChain) {
          await executeChain(pi, params.chain!, agents, cwd, ui, signal, run);
        } else if (hasTasks) {
          await executeParallel(params.tasks!, agents, cwd, ui, signal, run);
        } else {
          const agent = agents.find((a) => a.name === params.agent);
          if (!agent) {
            run.status = "failed";
            run.results.push({
              agent: params.agent!,
              source: "unknown",
              task: params.task!,
              exitCode: 1,
              output: "",
              error: `Unknown agent "${params.agent}". Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
            });
            finishRun(run, ui);
            return;
          }
          const r = await runChild(agent, params.task!, cwd, run, signal, (text) => {
            run.latestText = text;
          });
          run.results.push({
            agent: agent.name,
            source: agent.source,
            task: params.task!,
            exitCode: r.exitCode,
            output: r.output,
            error: r.error,
          });
          run.status = r.exitCode === 0 ? "done" : "failed";
          finishRun(run, ui);
          if (r.exitCode !== 0) {
            ui?.notify(`Subagent ${agent.name} failed: ${r.error ?? "unknown error"}`, "error");
          }
        }
        if (run.status === "done") {
          const summary = run.mode === "single"
            ? run.results[0]?.output.split("\n")[0] ?? ""
            : `chain/parallel done (${run.results.filter((r) => r.exitCode === 0).length}/${run.results.length} ok)`;
          ui?.notify(`Subagent done: ${summary.slice(0, 120)}`, "info");
        }
      };

      if (params.async) {
        // background: fire and forget, return run id
        void start().catch((err) => {
          run.status = "failed";
          run.results.push({ agent: run.agent, source: "unknown", task: "", exitCode: 1, output: "", error: String(err) });
          finishRun(run, ui);
        });
        return {
          content: [
            {
              type: "text",
              text: `Started background subagent run ${id}. Use subagent_wait with id "${id}" to collect the result.`,
            },
          ],
          details: { id, mode },
        };
      }

      // foreground: wait for completion
      await start();
      const content = buildResultContent(run);
      return {
        content: [{ type: "text", text: content }],
        details: {
          id,
          mode,
          status: run.status,
          results: run.results.map((r) => ({
            agent: r.agent,
            exitCode: r.exitCode,
            error: r.error,
            output: r.output,
          })),
        },
      };
    },
  });

  // ── subagent_wait tool ──
  pi.registerTool({
    name: "subagent_wait",
    label: "Subagent Wait",
    description: "Wait for a background subagent run to finish. Omit id to wait for all active runs. Use timeoutMs to cap the wait.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Run id from a subagent async call" })),
      timeoutMs: Type.Optional(Type.Integer({ description: "Max wait time in ms (default 300000)" })),
    }),
    async execute(_toolCallId, params) {
      const timeoutMs = params.timeoutMs ?? 300_000;
      if (runs.size === 0) {
        return { content: [{ type: "text", text: "No subagent runs active." }], details: {} };
      }
      const targets = params.id
        ? (runs.get(params.id) ? [runs.get(params.id)!] : [])
        : Array.from(runs.values()).filter((r) => r.status === "running" || r.status === "waiting-approval");
      if (targets.length === 0) {
        const r = params.id ? runs.get(params.id) : undefined;
        if (r) {
          return { content: [{ type: "text", text: `Run ${params.id} already finished (${r.status}).` }], details: {} };
        }
        return { content: [{ type: "text", text: `Run ${params.id ?? "(none)"} not found.` }], details: {} };
      }
      const wait = Promise.all(targets.map((t) => t.completion ?? Promise.resolve()));
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      await Promise.race([wait, timeout]);
      if (timer) clearTimeout(timer);
      const results = targets.map((t) => `${t.id} ${t.agent} ${t.status}`);
      return { content: [{ type: "text", text: results.join("\n") }], details: {} };
    },
  });

  // ── /subagents monitor ──
  pi.registerCommand("subagents", {
    description: "List running subagents and view a run's latest output",
    getArgumentCompletions: (prefix: string) => {
      const text = (prefix ?? "").trim();
      const items = Array.from(runs.values()).map((r) => ({
        value: r.id,
        label: r.id,
        description: `${r.mode} ${r.agent} ${r.status}${r.totalSteps ? ` ${r.currentStep ?? 1}/${r.totalSteps}` : ""}`,
      }));
      const filtered = items.filter((i) => i.value.startsWith(text));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (_args, ctx) => {
      if (runs.size === 0) {
        ctx.ui.notify("No subagent runs.", "info");
        return;
      }
      const list = Array.from(runs.values()).map((r) => {
        const done = r.results.length;
        const total = r.totalSteps ?? "?";
        const label = r.mode === "chain" ? `chain ${r.currentStep ?? 1}/${total}` : `${r.mode} (${done}/${total})`;
        return `${r.id}  ${label}  ${r.agent}  ${r.status}`;
      });
      const choice = await ctx.ui.select("Subagents:", list);
      if (!choice) return;
      const id = choice.split("  ")[0];
      const run = runs.get(id);
      if (!run) return;
      const latest = run.latestText || run.results.map((r) => r.output).filter(Boolean).join("\n") || "(no output yet)";
      ctx.ui.notify(`[${run.id}] ${run.agent} ${run.status}\n${latest.slice(-2000)}`, "info");
    },
  });
}
