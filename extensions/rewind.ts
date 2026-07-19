/**
 * rewind extension
 * c: worrie
 *
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let previousSessionFile: string | null = null;

  // ===================================================================
  // HELPERS
  // ===================================================================

  /** Check if cwd is a git repository */
  async function isGitRepo(): Promise<boolean> {
    try {
      const result = await pi.exec("git", ["rev-parse", "--git-dir"], {
        timeout: 5000,
      });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  /** Check if there are uncommitted changes (tracked + untracked) */
  async function hasChanges(): Promise<boolean> {
    try {
      const result = await pi.exec("git", ["status", "--porcelain"], {
        timeout: 5000,
      });
      // porcelain output is non-empty if there are any changes
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /** Create an auto-snapshot commit */
  async function createSnapshot(): Promise<string | null> {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const msg = "pi-rewind: snap-" + ts;

      await pi.exec("git", ["add", "-A"], { timeout: 10000 });
      const result = await pi.exec("git", ["commit", "-m", msg], {
        timeout: 10000,
      });

      if (result.code !== 0) return null;

      // Get the commit hash
      const hashResult = await pi.exec("git", ["rev-parse", "HEAD"], {
        timeout: 5000,
      });
      return hashResult.stdout.trim();
    } catch {
      return null;
    }
  }

  /** Get the list of snapshot commits from git log */
  async function getSnapshotCommits(): Promise<string[]> {
    try {
      const result = await pi.exec(
        "git",
        ["log", "--oneline", "--grep=pi-rewind: snap-", "--format=%H", "-10"],
        { timeout: 5000 },
      );
      if (result.code !== 0 || !result.stdout.trim()) return [];
      return result.stdout.trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Find the entry ID of the last user message */
  function findLastUserEntryId(
    entries: { id: string; type: string; message?: { role: string } }[],
  ): string | null {
    // Iterate backwards to find the last user message
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "message" && e.message?.role === "user") {
        return e.id;
      }
    }
    return null;
  }

  // ===================================================================
  // SNAPSHOT MANAGEMENT
  // ===================================================================

  /**
   * Called after each agent turn to auto-snapshot if there are changes.
   * Stores the commit hash in session memory for undo tracking.
   */
  async function autoSnapshot(): Promise<void> {
    if (!(await isGitRepo())) return;
    if (!(await hasChanges())) return;

    const hash = await createSnapshot();
    if (hash) {
      pi.appendEntry("rewind-snapshots", {
        hash: hash,
        timestamp: Date.now(),
        type: "snapshot",
      });
    }
  }

  // ===================================================================
  // SHARED UNDO/REDO CORE LOGIC
  // ===================================================================

  /**
   * Core undo logic: reverts the last snapshot commit.
   * Returns the target hash if successful, null if nothing to undo.
   * This can be called from both commands and shortcuts.
   */
  async function performUndoCore(): Promise<{ targetHash: string } | null> {
    if (!(await isGitRepo())) return null;

    const snapshots = await getSnapshotCommits();
    if (snapshots.length === 0) return null;

    const targetHash = snapshots[0];

    // Commit any uncommitted changes first
    if (await hasChanges()) {
      await createSnapshot();
    }

    // Revert the snapshot commit
    const revertResult = await pi.exec(
      "git",
      ["revert", "--no-edit", targetHash],
      { timeout: 30000 },
    );

    if (revertResult.code !== 0) {
      if (revertResult.stderr.includes("CONFLICT")) {
        await pi.exec("git", ["revert", "--abort"], { timeout: 10000 });
        return null;
      }
      return null;
    }

    return { targetHash };
  }

  /**
   * Core redo logic: reverts the last revert commit.
   * Returns true if successful, false if nothing to redo.
   */
  async function performRedoCore(): Promise<boolean> {
    if (!(await isGitRepo())) return false;

    const revertLog = await pi.exec(
      "git",
      ["log", "--oneline", '--grep=Revert "pi-rewind:', "--format=%H", "-1"],
      { timeout: 5000 },
    );

    if (revertLog.code !== 0 || !revertLog.stdout.trim()) return false;

    const revertHash = revertLog.stdout.trim();

    const redoResult = await pi.exec(
      "git",
      ["revert", "--no-edit", revertHash],
      { timeout: 30000 },
    );

    if (redoResult.code !== 0) {
      if (redoResult.stderr.includes("CONFLICT")) {
        await pi.exec("git", ["revert", "--abort"], { timeout: 10000 });
      }
      return false;
    }

    return true;
  }

  // ===================================================================
  // COMMANDS
  // ===================================================================

  pi.registerCommand("undo", {
    description:
      "Undo the last change. Reverts file changes via Git and forks the session to before the last user message.",
    handler: async (_args, ctx) => {
      if (!(await isGitRepo())) {
        ctx.ui.notify(
          "Not a Git repository. Initialize with 'git init' first.",
          "error",
        );
        return;
      }

      ctx.ui.notify("Undoing...", "info");
      const result = await performUndoCore();

      if (!result) {
        ctx.ui.notify("Nothing to undo.", "error");
        return;
      }

      // Fork the session to before the last user message
      const entries = ctx.sessionManager.getEntries();
      const lastUserEntryId = findLastUserEntryId(entries);

      if (lastUserEntryId) {
        ctx.ui.notify("Changes reverted. Forking session...", "info");
        await ctx.fork(lastUserEntryId, {
          position: "before",
          withSession: async (newCtx) => {
            newCtx.ui.notify(
              "Undone: changes reverted, session forked.",
              "info",
            );
          },
        });
      } else {
        ctx.ui.notify(
          "Changes reverted. Could not find a user message to fork from.",
          "info",
        );
      }
    },
  });

  pi.registerCommand("redo", {
    description:
      "Redo a previously undone change. Re-applies the last reverted Git commit.",
    handler: async (_args, ctx) => {
      if (!(await isGitRepo())) {
        ctx.ui.notify(
          "Not a Git repository. Initialize with 'git init' first.",
          "error",
        );
        return;
      }

      ctx.ui.notify("Re-applying changes...", "info");
      const success = await performRedoCore();

      if (!success) {
        ctx.ui.notify("Nothing to redo.", "error");
        return;
      }

      ctx.ui.notify(
        "Redo complete. Switching back to original session...",
        "info",
      );

      if (previousSessionFile) {
        await ctx.switchSession(previousSessionFile, {
          withSession: async (newCtx) => {
            newCtx.ui.notify(
              "Redo complete: files restored and conversation resumed.",
              "info",
            );
          },
        });
      } else {
        ctx.ui.notify(
          "Files restored. Could not find previous session to switch to.",
          "info",
        );
      }
    },
  });

  pi.registerCommand("rewind-history", {
    description: "Show the snapshot and undo history.",
    handler: async (_args, ctx) => {
      if (!(await isGitRepo())) {
        ctx.ui.notify("Not a Git repository.", "error");
        return;
      }

      const snapshots = await getSnapshotCommits();

      // Build history from git log
      let historyText = "## Rewind History\n\n";

      if (snapshots.length === 0) {
        historyText += "No snapshots found.\n";
      } else {
        for (let i = 0; i < Math.min(snapshots.length, 5); i++) {
          const hash = snapshots[i];
          const msgResult = await pi.exec(
            "git",
            ["log", "--oneline", "-1", hash],
            { timeout: 5000 },
          );
          const msg = msgResult.stdout.trim() || hash;
          historyText +=
            "- " +
            (i === 0 ? "**" : "") +
            msg +
            (i === 0 ? "** ← latest" : "") +
            "\n";
        }
      }

      pi.sendMessage({
        customType: "rewind-history",
        content: historyText,
        display: true,
        details: {},
      });
    },
  });

  // ===================================================================
  // EVENT HOOKS
  // ===================================================================

  // Auto-snapshot after each agent turn ends
  pi.on("turn_end", async () => {
    await autoSnapshot();
  });

  // Remember the old session file on fork so /redo can switch back
  pi.on("session_start", async (event) => {
    if (event.reason === "fork" && event.previousSessionFile) {
      previousSessionFile = event.previousSessionFile;
    }

    // Take a snapshot on session start to establish a baseline
    if (await isGitRepo()) {
      // Don't snapshot if the repo is clean (first start)
      if (await hasChanges()) {
        await createSnapshot();
      }
    }
  });
}
