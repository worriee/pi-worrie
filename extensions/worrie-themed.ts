// /worrie-themed command: custom worrie status bar footer for pi. c: worrie
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = join(process.cwd(), ".pi", "worrie-themed.json");

// Live context handle, refreshed on every hook so the footer never goes stale.
let latestCtx: any;
let latestModel: any;

function readConfig(): boolean {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")).enabled === true;
  } catch {
    return false;
  }
}

function writeConfig(enabled: boolean): void {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ enabled }, null, 2)}\n`);
}

/** "folder/project" label, tolerating the c: worrie comment in workspace.json. */
function projectLabel(): string {
  const folder = basename(process.cwd());
  try {
    const raw = readFileSync(
      join(process.cwd(), ".pi", "workspace.json"),
      "utf8",
    );
    const json = JSON.parse(
      raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1),
    );
    const name = json?.project_name;
    return name && name !== folder ? `${folder}/${name}` : folder;
  } catch {
    return folder;
  }
}

/** Token count abbreviation matching pi's built-in footer. */
function fmtTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Context segment in pi's built-in style: "12.3%/200k" or "?/200k". */
function contextSegment(theme: any): string {
  const usage = latestCtx?.getContextUsage?.();
  const window = usage?.contextWindow ?? 0;
  if (usage?.percent == null) {
    return theme.fg("dim", `?/${fmtTokens(window)}`);
  }
  const text = `${usage.percent.toFixed(1)}%/${fmtTokens(window)}`;
  if (usage.percent > 90) return theme.fg("error", text);
  if (usage.percent > 70) return theme.fg("warning", text);
  return theme.fg("dim", text);
}

/** Model segment with provider always shown: "(provider) id". */
function modelSegment(theme: any): string {
  const model =
    latestCtx?.getModel?.() ??
    (latestCtx?.model ? latestCtx.model : undefined) ??
    latestModel;
  if (!model?.id) return theme.fg("dim", "no-model");
  return model.provider
    ? `(${model.provider}) ${model.id}`
    : model.id;
}

export default function (pi: ExtensionAPI) {
  const applyFooter = (ctx: any): void => {
    if (ctx.mode !== "tui") return;
    latestCtx = ctx;
    ctx.ui.setFooter(
      (
        _tui: unknown,
        theme: { fg(color: string, text: string): string },
        footerData: {
          getGitBranch(): string | null;
          getExtensionStatuses(): ReadonlyMap<string, string>;
        },
      ) => ({
        render(width: number): string[] {
          const branch = footerData.getGitBranch() ?? "no git";
          const line1 = theme.fg(
            "dim",
            `${projectLabel()} : ${branch} | `,
          );
          const lines = [
            truncateToWidth(
              line1 + contextSegment(theme) + theme.fg("dim", " | ") + modelSegment(theme),
              width,
            ),
          ];
          const own: string[] = [];
          for (const [key, text] of footerData.getExtensionStatuses()) {
            if (key.startsWith("worrie") && text) own.push(text);
          }
          if (own.length > 0)
            lines.push(truncateToWidth(theme.fg("dim", own.join(" · ")), width));
          return lines;
        },
      }),
    );
  };

  pi.registerCommand("worrie-themed", {
    description: "Worrie status bar footer - On/Off",
    getArgumentCompletions: (prefix: string) => {
      const options = [
        { value: "on", label: "on", description: "Show worrie status bar" },
        {
          value: "off",
          label: "off",
          description: "Restore default pi footer",
        },
      ];
      const current =
        (prefix ?? "").trim().split(/\s+/).pop()?.toLowerCase() ?? "";
      if (!current) return options;
      return options.filter((o) => o.value.startsWith(current));
    },
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      let enabled: boolean | null =
        arg === "on" ? true : arg === "off" ? false : null;
      if (enabled === null) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("/worrie-themed needs the interactive TUI.", "warning");
          return;
        }
        const picked = await ctx.ui.select("Worrie themed status bar", [
          "On",
          "Off",
        ]);
        if (!picked) return;
        enabled = picked === "On";
      }
      writeConfig(enabled);
      if (enabled) {
        applyFooter(ctx);
        ctx.ui.notify("Worrie status bar ON.", "info");
      } else {
        ctx.ui.setFooter(undefined);
        ctx.ui.notify(
          "Worrie status bar OFF - default footer restored.",
          "info",
        );
      }
    },
  });

  // keep the live context fresh + restore the saved footer state
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    if (readConfig()) applyFooter(ctx);
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
  });
  pi.on("turn_start", async (_event, ctx) => {
    latestCtx = ctx;
  });
  pi.on("model_select", async (event) => {
    latestModel = event.model;
  });
}
