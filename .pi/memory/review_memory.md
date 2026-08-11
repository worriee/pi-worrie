# Code Review Log Memory

## 0. Last Synchronized Checkpoint

- **Last AI Analysis Timestamp**: July 22, 2026, 10:02 AM PST

## 1. Active & Open Review Findings

### [REVIEW-004] README.md — out of date with new rewind design

- **File/Path**: `README.md`
- **Severity**: HIGH
- **Category**: Correctness
- **Finding**: README still describes old Git-based snapshot system. Needs update for new file-snapshot stack-based undo/redo.
- **Recommendation**: Update README to describe current file-snapshot behavior, stack limits, and commands (/undo, /redo, /rewind-history).
- **Status**: OPEN
- **Reviewed At**: July 22, 2026, 10:02 AM PST

### [REVIEW-015] Redo directory lifecycle not initialized at startup

- **File/Path**: `extensions/pi-rewind/rewind.ts:130-146`
- **Severity**: LOW
- **Category**: Maintainability
- **Finding**: `redo/` directory only created on first `/undo`. No mkdir for `redo/` at startup. Works at runtime but asymmetric with `undo/`.
- **Recommendation**: Initialize both `undo/` and `redo/` dirs at startup or document asymmetry.
- **Status**: OPEN
- **Reviewed At**: July 22, 2026, 10:02 AM PST

### [REVIEW-014] Disk errors silently swallowed with empty catches

- **File/Path**: `extensions/pi-rewind/rewind.ts:74-85,124-130,141-145,152-155`
- **Severity**: LOW
- **Category**: Maintainability
- **Finding**: Multiple try-catch blocks with empty catch or `// best effort`. Makes debugging disk issues impossible.
- **Recommendation**: Log errors to console or at minimum add descriptive comments.
- **Status**: OPEN
- **Reviewed At**: July 22, 2026, 10:02 AM PST

### [REVIEW-013] State file not atomically written

- **File/Path**: `extensions/pi-rewind/rewind.ts:41`
- **Severity**: LOW
- **Category**: Correctness
- **Finding**: `writeState` writes directly to STATE_FILE. Interrupt (crash, power loss) in the middle produces truncated JSON → `readState` silently returns `defaultState()`, losing all history.
- **Recommendation**: Write to temp file then rename, or keep backup copy.
- **Status**: OPEN
- **Reviewed At**: July 22, 2026, 10:02 AM PST

### [REVIEW-012] Stale snapshot directories from old toggle design never cleaned

- **File/Path**: `extensions/pi-rewind/snapshots/0/`, `1/`
- **Severity**: LOW
- **Category**: Maintainability
- **Finding**: Old toggle-based snapshot dirs `0/` and `1/` left over from previous design. No cleanup mechanism.
- **Recommendation**: Remove orphaned dirs manually or add startup cleanup.
- **Status**: OPEN
- **Reviewed At**: July 22, 2026, 10:02 AM PST

### [REVIEW-011] No size cap on restore side — corrupt JSON writes arbitrary data

- **File/Path**: `extensions/pi-rewind/rewind.ts:108-112`
- **Severity**: MEDIUM
- **Category**: Correctness
- **Finding**: `snapshotFiles` skips files >1MB, but `restoreFiles` writes everything back without validation. A corrupt `files.json` with massive entries could write arbitrary data.
- **Recommendation**: Add file size cap in `restoreFiles` matching the 1MB limit in `snapshotFiles`.
- **Status**: OPEN
- **Reviewed At**: July 22, 2026, 10:02 AM PST

### [REVIEW-009] Timestamp IDs can collide

- **File/Path**: `extensions/pi-rewind/rewind.ts:130,165,273`
- **Severity**: MEDIUM
- **Category**: Correctness
- **Finding**: `String(Date.now())` uses ms granularity. If `turn_end` fires twice in the same ms, or undo/redo in the same ms, snapshot IDs collide — one overwrites the other's files.
- **Recommendation**: Append counter or random suffix to IDs.
- **Status**: OPEN
- **Reviewed At**: July 22, 2026, 10:02 AM PST

---

## 2. Historical & Resolved Reviews

_Move reviews to this section once they are completely verified as resolved. This serves as historical memory to prevent the AI from re-introducing the same issues._

> STRICT RULE: When a review finding in Section 1 is remediated, the AI MUST migrate it to this section within the SAME response using `### [RESOLVED] Short Review Description (REVIEW-XXX)`. All headers in this file are IMMUTABLE. Existing resolved entries MUST NOT be deleted, truncated, or rewritten. New resolved entries are prepended (LIFO) directly under the Section 2 header. The original REVIEW-XXX tracking number MUST be preserved in the resolved header. Failure to migrate immediately is a CRITICAL VIOLATION.

### [RESOLVED] All files scanned + read on every turn_end (REVIEW-010)

- **The Issue**: Every AI turn read ALL file contents via `readFileSync` into memory. On 5000-file projects, this is O(n) I/O per turn.
- **The Resolution**: `snapshotFiles` now accepts `sinceTimestamp`. `pushStack` passes the previous snapshot's timestamp. Files whose `mtimeMs` is older or equal are skipped — only changed files are read and saved. First snapshot still does full backup.
- **Prevention Strategy**: Use file modification timestamps to skip unchanged files instead of re-reading everything.

### [RESOLVED] pi.appendEntry may not exist on ExtensionAPI (REVIEW-008)

- **The Issue**: `pi.appendEntry("rewind-snapshots", ...)` called on `ExtensionAPI` object. Method existence not verified — risk of runtime error.
- **The Resolution**: Code deleted — the `pi.appendEntry` line was orphaned from the old Git-based logic. No other code reads the data. Line removed entirely, eliminating the risk.
- **Prevention Strategy**: Delete orphaned API calls when replacing an implementation. If data is never read, don't write it.

### [RESOLVED] Redo session tracking broken after multiple undos (REVIEW-007)

- **The Issue**: `lastSessionFile` global field overwritten on every fork. After undo→undo→redo→redo, second redo switched to wrong session.
- **The Resolution**: Added `sessionFile?: string` to `StackEntry`. Removed global `lastSessionFile` from state. `session_start` attaches session file to `redo[0].sessionFile`. `/redo` reads from popped entry instead of globals.
- **Prevention Strategy**: Per-entry session tracking — each redo level remembers its own session target.

### [RESOLVED] Rewind getSnapshotCommits matches revert commits (REVIEW-001)

- **The Issue**: `getSnapshotCommits()` used `git log --grep=pi-rewind: snap-` which also returned revert commits. Second `/undo` reverted the revert, re-applying original changes.
- **The Resolution**: Code deleted — entire rewind.ts replaced with stack-based file-snapshot system. No Git involved.
- **Prevention Strategy**: N/A — code removed, not fixed.

### [RESOLVED] Undo previousSessionFile null outside forked session (REVIEW-002)

- **The Issue**: Redo switches to `previousSessionFile` only tracked on `session_start` with `reason === "fork"`. Outside forked session, `previousSessionFile` is null.
- **The Resolution**: Code deleted — entire rewind.ts replaced with stack-based file-snapshot system.
- **Prevention Strategy**: N/A — code removed, not fixed.

### [RESOLVED] Redo only works for most recent undo (REVIEW-003)

- **The Issue**: `performRedoCore()` used `-1` to find only the latest revert commit. Undo history beyond 1 level lost.
- **The Resolution**: Code deleted — entire rewind.ts replaced with stack-based undo/redo with depth 10.
- **Prevention Strategy**: N/A — code removed, replaced with stack approach.

### [RESOLVED] Updater output parsing fragile and locale-dependent (REVIEW-006)

- **The Issue**: Output parsing checked "up to date" before npm install indicators. "pi is already up to date" line overrode actual update detection.
- **The Resolution**: Simplified to two states: check "added" or "audited" first → "Updates applied successfully.". Default else → "Everything is up to date.". Empty-output guard added.
- **Prevention Strategy**: Parse output by checking strongest success indicators first (package install messages), then fall back to default up-to-date message.

### [RESOLVED] Updater uses exec from node:child_process instead of pi.exec (REVIEW-005)

- **The Issue**: Used `exec` from `node:child_process` for shell execution instead of `pi.exec()`, inconsistent with rewind.ts.
- **The Resolution**: Accepted as intentional — `pi.exec` doesn't resolve global `pi` binary PATH on Windows. `exec` with shell is the working approach.
- **Prevention Strategy**: When spawning CLI tools installed as global npm packages, use shell exec for PATH resolution.

---

## 3. Review Summary Metrics

- **Total Reviews Conducted**: 2
- **Critical Findings**: 0
- **High Findings**: 2
- **Medium Findings**: 2
- **Low Findings**: 4
- **Last Review Date**: `July 22, 2026, 10:02 AM PST`

---

## 4. ARCHIVE STATUS

- **Archive File**: `.pi/archives/review_archive.md`
- **Threshold**: 10 active entries per section
- **Total Archived**: 0
- **Last Archive Check**: `Not yet performed`

| Entries Archived | Archived At (PST) |
| ---------------- | ----------------- |
| 0                | —                 |

<!-- c: worrie -->
