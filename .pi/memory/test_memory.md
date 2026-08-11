# Test Strategy & Coverage Memory

## 0. Last Synchronized Checkpoint

- **Last AI Analysis Timestamp**: July 22, 2026, 10:02 AM PST

## 1. Active Test Strategies

### [TEST-001] Rewind extension — pure function unit tests

- **File/Path**: `extensions/pi-rewind/rewind.ts`
- **Type**: Unit
- **Preconditions**: Node.js with fs module available. Temp directory for snapshot tests.
- **Test Input**: See sub-functions below.
- **Expected Output**: Functions return correct values for all branches.
- **Assertions**:
  - `findLastUserEntry()`: empty array → null; no user msgs → null; last user msg with string content returns correct id+text; last user msg with array content returns text from first block
  - `defaultState()`: returns `{undo:[], redo:[], lastSessionFile:null}`
  - `readState()`: missing file → defaultState; valid file → parsed JSON; corrupt file → defaultState
  - `getAllFiles()`: excludes hidden files/dirs except .gitignore; excludes prefix paths; skips files >1MB; includes regular files
  - `pushStack()`: creates snapshot dir with files.json; prepends to state; prunes oldest at MAX_STACK+1
  - `popStack()`: empty stack → null; normal pop returns files+entry; removes snapshot dir; removes from state
- **Framework**: `assert`-based standalone script (no framework needed)
- **Coverage Target**: 90% for pure functions
- **Coverage Status**: UNCOVERED
- **Logged At**: July 22, 2026, 10:02 AM PST

### [TEST-002] Rewind extension — manual integration verification

- **File/Path**: `extensions/pi-rewind/rewind.ts`
- **Type**: Integration
- **Preconditions**: Pi running with extension loaded. Project with some files.
- **Test Input**: Manual commands.
- **Expected Output**: See checklist.
- **Assertions**:
  - `/undo` when no snapshots → "Nothing to undo."
  - `/redo` when no redo → "Nothing to redo."
  - `/undo` after AI makes changes → files restored, conversation forked before last user msg
  - `/undo` twice → goes back deeper
  - `/redo` after undo → files restored forward, session resumes
  - `/redo` after multiple undos → session tracking correct for each level
  - `turn_end` fires after AI turn → snapshot created in undo stack
  - `/rewind-history` shows correct stack depths
- **Framework**: Manual checklist
- **Coverage Target**: N/A
- **Coverage Status**: UNCOVERED
- **Logged At**: July 22, 2026, 10:02 AM PST

---

## 2. Historical & Resolved Test Strategies

_Move test strategies to this section once they are completely verified as resolved. This serves as historical memory to prevent the AI from re-introducing the same test gaps._

### [RESOLVED] Short Test Description (TEST-XXX)

- **The Issue**: Brief summary of what was failing or uncovered
- **The Resolution**: How it was addressed (test added, coverage improved, flaky test fixed)
- **Prevention Strategy**: What testing guideline should be followed to avoid regression
- **Verified Coverage**: Final coverage percentage after resolution
- **Resolved At**: [Month Day, Year, HH:MM AM/PM PST]

---

## 3. Test Summary Metrics

- **Total Test Cases Designed**: 2
- **Unit Tests**: 1
- **Integration Tests**: 1
- **E2E Tests**: 0
- **Performance Tests**: 0
- **Overall Coverage**: 0%
- **Last Test Run**: `Not yet performed`

---

## 3.5 Strict Resolution Protocol

- **Immediate Migration**: When an active test strategy in Section 1 is implemented or verified, it MUST be migrated to Section 2 in the SAME response using `### [RESOLVED] Short Test Description (TEST-XXX)`.
- **Header Lock**: All section headers in this file are IMMUTABLE. The AI is FORBIDDEN from editing, renaming, adding, or deleting any `#`, `##`, or `###` system header.
- **Historical Preservation**: Existing resolved entries in Section 2 MUST NOT be deleted, truncated, or rewritten. New resolved entries are prepended (LIFO) directly under the Section 2 header.
- **Tracking Number Retention**: The original TEST-XXX number from the active entry MUST be preserved in the resolved header as `(TEST-XXX)`.
- **Violation Severity**: Failure to migrate immediately or to preserve history is a CRITICAL VIOLATION.

---

## 4. ARCHIVE STATUS

- **Archive File**: `.pi/archives/test_archive.md`
- **Threshold**: 10 active entries per section
- **Total Archived**: 0
- **Last Archive Check**: `Not yet performed`

| Entries Archived | Archived At (PST) |
| ---------------- | ----------------- |
| 0                | —                 |

<!-- c: worrie -->
