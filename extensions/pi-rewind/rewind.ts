/**
 * rewind extension
 * c: worrie
 *
 * Undo/redo via file snapshots — no Git.
 * Stack-based: each undo goes deeper, each redo goes forward.
 * Snapshots stored in extensions/pi-rewind/snapshots/.
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
} from "fs";
import { join, dirname } from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ROOT = process.cwd();
const SNAPSHOTS_DIR = join(ROOT, "extensions", "pi-rewind", "snapshots");
const STATE_FILE = join(SNAPSHOTS_DIR, "state.json");
const MAX_STACK = 10;

// ===================================================================
// STATE helpers
// ===================================================================

interface StackEntry {
  id: string;
  timestamp: number;
}

interface RewindState {
  undo: StackEntry[];
  redo: StackEntry[];
  lastSessionFile: string | null;
}

function defaultState(): RewindState {
  return { undo: [], redo: [], lastSessionFile: null };
}

function readState(): RewindState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
    // fall through
  }
  return defaultState();
}

function writeState(state: RewindState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ===================================================================
// FILE helpers
// ===================================================================

/** Recursively get all file paths relative to ROOT. Exclude by prefix. */
function getAllFiles(
  dir: string,
  excludePrefixes: string[],
  base = "",
): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((d) => d.name);
  } catch {
    return results;
  }
  for (const name of entries) {
    const rel = base ? `${base}/${name}` : name;
    // Skip hidden entries except .gitignore
    if (name.startsWith(".") && name !== ".gitignore") continue;
    // Skip excluded prefixes
    if (excludePrefixes.some((p) => rel === p || rel.startsWith(p + "/")))
      continue;
    const full = join(dir, name);
    try {
      const s = statSync(full);
      if (s.isDirectory()) {
        results.push(...getAllFiles(full, excludePrefixes, rel));
      } else if (s.isFile() && s.size <= 1_048_576) {
        results.push(rel);
      }
    } catch {
      // skip unreadable
    }
  }
  return results;
}

/** Save current workspace files into a snapshot dir as files.json. */
function snapshotFiles(files: string[], destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const map: Record<string, string> = {};
  for (const f of files) {
    try {
      map[f] = readFileSync(join(ROOT, f), "utf-8");
    } catch {
      // skip unreadable
    }
  }
  writeFileSync(join(destDir, "files.json"), JSON.stringify(map), "utf-8");
}

/** Restore files from a parsed files.json object back to workspace. */
function restoreFiles(files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(ROOT, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
  }
}

// ===================================================================
// STACK helpers
// ===================================================================

const EXCLUDE_PREFIXES = [
  ".git",
  "node_modules",
  ".pi",
  "extensions/pi-rewind/snapshots",
];

function pushStack(stackKey: "undo" | "redo", id: string): void {
  const state = readState();

  // Snapshot current workspace
  const files = getAllFiles(ROOT, EXCLUDE_PREFIXES);
  const snapDir = join(SNAPSHOTS_DIR, stackKey, id);
  snapshotFiles(files, snapDir);

  // Prepend entry
  const entry: StackEntry = { id, timestamp: Date.now() };
  state[stackKey].unshift(entry);

  // Prune oldest if over limit
  while (state[stackKey].length > MAX_STACK) {
    const removed = state[stackKey].pop()!;
    const removedDir = join(SNAPSHOTS_DIR, stackKey, removed.id);
    try {
      rmSync(removedDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }

  writeState(state);
}

function popStack(
  stackKey: "undo" | "redo",
): { files: Record<string, string>; entry: StackEntry } | null {
  const state = readState();
  if (state[stackKey].length === 0) return null;

  const entry = state[stackKey].shift()!;
  const snapDir = join(SNAPSHOTS_DIR, stackKey, entry.id);
  const filesPath = join(snapDir, "files.json");

  let files: Record<string, string> = {};
  try {
    if (existsSync(filesPath)) {
      files = JSON.parse(readFileSync(filesPath, "utf-8"));
    }
  } catch {
    // treat as empty
  }

  // Remove snapshot dir
  try {
    rmSync(snapDir, { recursive: true, force: true });
  } catch {
    // best effort
  }

  writeState(state);
  return { files, entry };
}

/** Find last user message entry and return its id + text. */
function findLastUserEntry(
  entries: {
    id: string;
    type: string;
    message?: { role: string; content?: any };
  }[],
): { id: string; text: string } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "message" && e.message?.role === "user") {
      const c = e.message?.content;
      const text = typeof c === "string" ? c : c?.[0]?.text || "";
      return { id: e.id, text };
    }
  }
  return null;
}

// ===================================================================
// COMMANDS
// ===================================================================

export default function (pi: ExtensionAPI) {
  pi.registerCommand("undo", {
    description: "Undo last change.",
    handler: async (_args, ctx) => {
      const state = readState();
      if (state.undo.length === 0) {
        ctx.ui.notify("Nothing to undo.", "error");
        return;
      }

      // Save current state to redo stack before undoing
      const redoId = String(Date.now()) + "-redo";
      pushStack("redo", redoId);

      // Pop undo stack and restore files
      const popped = popStack("undo");
      if (!popped) {
        ctx.ui.notify("Nothing to undo.", "error");
        return;
      }
      restoreFiles(popped.files);

      // Fork conversation to before the last user message
      const entries = ctx.sessionManager.getEntries();
      const lastUser = findLastUserEntry(entries);
      if (lastUser) {
        await ctx.fork(lastUser.id, {
          position: "before",
          withSession: async (newCtx) => {
            newCtx.ui.notify("Undone", "info");
          },
        });
      } else {
        ctx.ui.notify("Undone", "info");
      }
    },
  });

  pi.registerCommand("redo", {
    description: "Redo a previously undone change.",
    handler: async (_args, ctx) => {
      const state = readState();
      if (state.redo.length === 0) {
        ctx.ui.notify("Nothing to redo.", "error");
        return;
      }

      // Save current state to undo stack before redoing
      const undoId = String(Date.now()) + "-undo";
      pushStack("undo", undoId);

      // Pop redo stack and restore files
      const popped = popStack("redo");
      if (!popped) {
        ctx.ui.notify("Nothing to redo.", "error");
        return;
      }
      restoreFiles(popped.files);

      // Switch session forward if available
      const s = readState();
      if (s.lastSessionFile) {
        await ctx.switchSession(s.lastSessionFile, {
          withSession: async (newCtx) => {
            newCtx.ui.notify("Redone", "info");
          },
        });
      } else {
        ctx.ui.notify("Redone", "info");
      }
    },
  });

  pi.registerCommand("rewind-history", {
    description: "Show undo/redo stack history.",
    handler: async (_args, ctx) => {
      const state = readState();
      let text = "## Rewind History\n\n";

      if (state.undo.length === 0 && state.redo.length === 0) {
        text += "No snapshots yet.\n";
      } else {
        text += `**Undo stack:** ${state.undo.length} snapshot(s)\n`;
        for (const e of state.undo) {
          text += `- snapshot ${e.id.slice(-8)} (${new Date(e.timestamp).toLocaleTimeString()})\n`;
        }
        text += `\n**Redo stack:** ${state.redo.length} snapshot(s)\n`;
        for (const e of state.redo) {
          text += `- snapshot ${e.id.slice(-8)} (${new Date(e.timestamp).toLocaleTimeString()})\n`;
        }
      }

      pi.sendMessage({
        customType: "rewind-history",
        content: text,
        display: true,
        details: {},
      });
    },
  });

  // ===================================================================
  // EVENT HOOKS
  // ===================================================================

  pi.on("turn_end", async () => {
    const id = String(Date.now());
    pushStack("undo", id);
    pi.appendEntry("rewind-snapshots", {
      timestamp: Date.now(),
      type: "snapshot",
    });
  });

  pi.on("session_start", async (event: any) => {
    if (event.reason === "fork" && event.previousSessionFile) {
      const state = readState();
      state.lastSessionFile = event.previousSessionFile;
      writeState(state);
    }
  });
}
