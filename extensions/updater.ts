/**
 * pi-updater — /updater extension
 * c: worrie
 *
 * Registers /updater command that runs `pi update --all`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("updater", {
    description: "Update pi extensions and pi itself",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Checking for updates...", "info");

      try {
        const result = await pi.exec("pi", ["update", "--all"], {
          timeout: 120_000,
        });

        const out = (result.stdout + result.stderr).toLowerCase();

        if (
          out.includes("up to date") ||
          out.includes("nothing to update") ||
          out.includes("already up-to-date")
        ) {
          ctx.ui.notify("Everything is up-to-date.", "info");
        } else if (result.code === 0) {
          ctx.ui.notify("Updates applied successfully.", "info");
        } else {
          ctx.ui.notify("Update finished with warnings.", "warn");
        }
      } catch (err) {
        ctx.ui.notify(
          `Update failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
