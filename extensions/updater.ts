/**
 * updater extension
 * c: worrie
 *
 * Registers /updater command that runs `pi update --extensions`.
 */
import { exec } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("updater", {
    description: "Updates pi and it's extensions",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Checking for updates...", "info");

      try {
        const { stdout, stderr } = await new Promise<{
          stdout: string;
          stderr: string;
        }>((resolve, reject) => {
          exec(
            "pi update --all",
            { timeout: 120_000 },
            (err, stdout, stderr) => {
              if (err) reject(err);
              else resolve({ stdout, stderr });
            },
          );
        });

        const raw = (stdout + stderr).trim();
        const out = raw.toLowerCase();

        if (!raw) {
          ctx.ui.notify("No update output received.", "info");
        } else if (out.includes("added") || out.includes("audited")) {
          ctx.ui.notify("Updates applied successfully.", "info");
        } else {
          ctx.ui.notify("Everything is up to date.", "info");
        }
      } catch (err: any) {
        ctx.ui.notify(
          `Update failed: ${err.message ?? String(err)}`,
          "error",
        );
      }
    },
  });
}
