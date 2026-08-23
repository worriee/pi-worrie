// /worrie-themed command: custom worrie status bar footer for pi. c: worrie
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = join(process.cwd(), ".pi", "worrie-themed.json");

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

export default function (pi: ExtensionAPI) {
  const applyFooter = (ctx: any): void => {
    if (ctx.mode !== "tui") return;
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
          const percent = ctx?.getContextUsage?.()?.percent;
          const percentText = percent == null ? "--" : `${Math.round(percent)}%`;
          const model = ctx?.getModel?.()?.label ?? "no model";
          const branch = footerData.getGitBranch() ?? "no git";
          const line1 = `${projectLabel()} : ${branch} | ctx ${percentText} | ${model}`;
          const lines = [theme.fg("dim", line1)];
          const own: string[] = [];
          for (const [key, text] of footerData.getExtensionStatuses()) {
            if (key.startsWith("worrie") && text) own.push(text);
          }
          if (own.length > 0) lines.push(theme.fg("dim", own.join(" · ")));
          return lines.map((l) => truncateToWidth(l, width));
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

  // restore on startup / session switch when saved as enabled
  pi.on("session_start", async (_event, ctx) => {
    if (readConfig()) applyFooter(ctx);
  });
}
