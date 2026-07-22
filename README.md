# pi-worrie

A collection of my own pi extensions.

> some are AI generated and mimics other extensions then combined with my ideas to match my desired workflow.

---

## Extensions

### Updater

> updates pi and it's extensions

Runs `pi update --all` directly without the need of using terminal.

**Commands:**

- **`/updater`** — Runs `pi update --all` in background. Notifies when done.

---

### Rewind

> Undo/Redo using file snapshots

Auto-saves your files after every AI turn. Lets you undo/redo file + conversation changes.

**Commands:**

- **`/undo`** — Restores files + conversations from the last snapshot.
- **`/redo`** — Moves forward through undone steps. Restores files + conversations
- **`/rewind-history`** — Shows available undo/redo snapshots with file counts.

---

## Installation (if you wanna try)

```bash
pi install git:github.com/worriee/pi-worrie
```

---

## Requirements

- Pi with extension support (≥ 0.74.0).

---

## Credit

By [**Worrie**](https://github.com/worriee)
