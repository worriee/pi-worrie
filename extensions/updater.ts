/**
 * pi-updater — /updater extension
 * c: worrie
 *
 * Registers /updater command that runs `pi update --all`.
 */
import { exec } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("updater", {
    description: "Update pi extensions and pi itself",
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

        const out = (stdout + stderr).toLowerCase();

        if (
          out.includes("up to date") ||
          out.includes("nothing to update") ||
          out.includes("already up-to-date")
        ) {
          ctx.ui.notify("Everything is up-to-date.", "info");
        } else {
          ctx.ui.notify("Updates applied successfully.", "info");
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
