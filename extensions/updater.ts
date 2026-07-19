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
    description: "Run pi update --all in terminal",
    handler: async (_args, ctx) => {
      exec("pi update --all", (error, stdout, stderr) => {
        if (error) {
          ctx.ui.notify(`Update failed: ${error.message}`, "error");
          return;
        }
        if (stdout) ctx.ui.notify(stdout.trim(), "info");
        if (stderr) ctx.ui.notify(stderr.trim(), "warn");
      });
      ctx.ui.notify("Running pi update --all...", "info");
    },
  });
}
