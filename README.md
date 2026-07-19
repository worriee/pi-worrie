# pi-worrie

A collection of my own pi extensions.

> some are AI generated and copy of other ideas extension packages then combined with my ideas to match my desired workflow.

---

## Extensions

### **updater**

> updates pi extensions and pi itself

Runs `pi update --all` directly without the need of using terminal.

**Commands:**

- **`/updater`** — Runs `pi update --all` in background. Notifies when done.

---

### **rewind**

> Undo/Redo for Pi using Git snapshots

Creates automatic Git snapshots after every agent turn. Lets you undo/redo file + conversation changes.

**Commands:**

- **`/undo`** — Reverts last file + conversation changes via Git, forks session to before last user message.
- **`/redo`** — Re-applies the last reverted change and switches back to original session.
- **`/rewind-history`** — Shows snapshot history inline.

---

## Installation (if you wanna try)

```bash
pi install git:github.com/worriee/pi-worrie
```

---

## Requirements

- A Git repository in your project (run `git init` first) — required for rewind extension.
- Pi with extension support (≥ 0.74.0).

---

## Credit

By [**Worrie**](https://github.com/worriee)
