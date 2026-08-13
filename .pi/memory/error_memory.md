# Workspace Error Log & Debugging Memory

## 0. Last Synchronized Checkpoint

- **Last Error Check**: August 13, 2026, 04:13 PM PST

## 1. Active & Unresolved Errors

_List errors currently blocking development. Update this section immediately when a new error occurs during execution or user prompting._

### [ERR-005] Refresh re-run drops c: worrie credit marker after RULES_END sentinel removal

- **The Issue**: Removing the `<!-- end rules -->` sentinel and reusing the credit marker as the rules block boundary exposed a slice bug in `refreshRulesSection()`: `tail = content.slice(eIdx + RULES_END.length)` consumed the marker itself, so re-running `/setup` on an existing agent file produced a file with ZERO credit markers.
- **Impact**: Generated agent files lost the single `c: worrie` credit on refresh; `<!-- end rules -->` stray comment also violated the "only c: worrie at EOF" requirement.

_No active blockers as of August 13, 2026, 04:13 PM PST sync. ERR-001 fixed; ERR-004 + ERR-005 resolved same-session — see Section 2._

---

## 2. Historical & Resolved Errors

_Move errors to this section once they are completely verified as fixed. This serves as historical memory to prevent the AI from re-introducing the same bugs._

### [RESOLVED] Refresh re-run drops c: worrie credit marker after RULES_END sentinel removal (ERR-005)

- **The Issue**: After dropping the `<!-- end rules -->` sentinel, `refreshRulesSection()` sliced the tail past the credit marker (`slice(eIdx + RULES_END.length)`), deleting it on `/setup` re-runs.
- **The Resolution**: `refreshRulesSection()` now uses `content.lastIndexOf(RULES_END)` and `tail = content.slice(eIdx)` — the marker is preserved as part of the tail, never consumed. Heal/append branches (no marker or no rules block found) append `RULES_END` so every rebuilt file ends with exactly one credit marker. `rulesBlock()` emits no terminator marker; `RULES_END` is only a boundary + final credit.
- **Verification**: 18/18 checks PASS — build + refresh for all 8 personas, plus heal-branch and append-branch: no `end rules` substring anywhere, exactly 1 `c: worrie`, last non-blank line is `<!-- c: worrie -->`.
- **Prevention Strategy**: Block terminators must never be emitted inside the rules block; boundary search must keep the boundary string in the tail slice. Re-verify refresh on re-run paths when touching marker assembly.

### [RESOLVED] Duplicate c: worrie credit markers in generated agent files (ERR-004)

- **The Issue**: `buildAgentFile()` emitted 2-3 `<!-- c: worrie -->` markers per generated agent file (RULES_END terminator + EOF append + leaked indented marker from worrie-debugger skill).
- **The Resolution**: `RULES_END` changed to a non-credit sentinel `<!-- end rules -->` (keeps refreshRulesSection block boundary working); skill marker strip regex hardened to `/\s*<!--\s*c: worrie\s*-->\s*$/` (handles indented markers). EOF `<!-- c: worrie -->` is now the sole credit marker, on the last line.
- **Verification**: Simulated buildAgentFile against all 8 real SKILL.md files — 8/8 PASS: exactly 1 marker, last line is `<!-- c: worrie -->`.
- **Prevention Strategy**: Any future marker assembly must keep exactly one `c: worrie` occurrence at file EOF; block terminators must use non-credit sentinels. Existing generated files (pre-fix) must be deleted and regenerated via `/setup` — `refreshRulesSection` cannot strip legacy mid-file markers on old files.

### [RESOLVED] Redo session tracking broken after multiple undos (ERR-003)

- **The Issue**: `lastSessionFile` was a single field overwritten on every fork. After undo→undo→redo→redo, second redo switched to wrong session.
- **The Resolution**: Removed global `lastSessionFile` from state. Each redo entry now stores its own `sessionFile` set by `session_start`. `/redo` reads session file from the popped entry instead of globals.
- **Prevention Strategy**: Per-entry session tracking instead of global field — each redo level remembers its own session target.

### [RESOLVED] Updater output parsing — wrong pattern matching (ERR-001)

- **The Issue**: `/updater` showed "Everything is up-to-date." even when updates ran. Output parsing checked "up to date" before "added"/"audited", so the final line "pi is already up to date" overrode the actual update detection.
- **The Resolution**: Reordered checks: "added" and "audited" now checked BEFORE "up to date". Simplified to just two states: if "added"/"audited" → "Updates applied successfully." else → "Everything is up to date.". Command kept as `pi update --all` to update both pi and extensions.
- **Prevention Strategy**: Output parsing must check for strong update indicators (package install messages) before checking for idle-state messages.

### [RESOLVED] Rewind getSnapshotCommits matches revert commits (ERR-002)

- **The Issue**: `getSnapshotCommits()` used `git log --grep=pi-rewind: snap-` which also returned revert commits. Second `/undo` would revert the revert, re-applying the original changes instead of doing nothing.
- **The Resolution**: Changed `git log` format from `--format=%H` to `--format=%H%n%s` (hash + subject on separate lines). Loop filters out commits whose subject line starts with "Revert". Only non-revert snapshot hashes are returned.
- **Prevention Strategy**: Any future grep-based commit search must explicitly filter out revert commits by checking the subject prefix.

---

## 3. Persistent Debugging Rules

- **Lookback Before Guessing**: Before attempting to fix any code, cross-reference this file to see if a similar failure has happened before.
- **Immediate Documentation**: Every time a debugger action fails or reveals a new error, log it under section 1 before writing any fixes.
- **Clean Transitions**: When an error is resolved, update its status, document the solution, and shift it to section 2.

---

## 4. ARCHIVE STATUS

- **Archive File**: `.pi/archives/error_archive.md`
- **Threshold**: 10 active entries per section
- **Total Archived**: 0
- **Last Archive Check**: `Not yet performed`

| Entries Archived | Archived At (PST) |
| ---------------- | ----------------- |
| 0                | —                 |

<!-- c: worrie -->
