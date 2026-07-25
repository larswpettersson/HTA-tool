# HTA Tool — Hierarchical Task Analysis + TTA

Tools for creating and visualizing Hierarchical Task Analysis (HTA) diagrams with Tabular Task Analysis (TTA / HEI fields).

## HTA + TTA Editor (`HTA.html`)

Primary editor. Open [`HTA.html`](HTA.html) in a modern browser — no build step. Logic lives in [`scripts/hta-app.js`](scripts/hta-app.js). Design reference: Penpot **HFA DS → TTA draft**.

### Layout

| Panel | Role |
| --- | --- |
| **HTA** (left) | Hierarchy tree — source of truth for tasks and IDs |
| **TTA** (right) | Table of HEI fields linked to tasks by `taskId` |

Selecting a task in HTA highlights matching TTA rows (and the reverse). Every HTA task always has at least one TTA row.

### Getting started

1. Open `HTA.html` in a browser.
2. Click a task to select it (IDs are display-only).
3. Click the **description** (or press **Enter** when focused) to edit the title; **Enter** applies, **Esc** cancels.
4. Use toolbar buttons or shortcuts to grow the tree.
5. Fill HEI cells in the TTA table; use **Add row** for extra HEI rows on the selected task.
6. **Export** saves full state as JSON; **Export CSV** (TTA toolbar) saves Excel/SmartArt-friendly CSV.

Sample data: [`fixtures/hta-tta-sample.json`](fixtures/hta-tta-sample.json) — use top-bar **Import**.

### Toolbar

| Control | What it does |
| --- | --- |
| Light / Dark | Theme |
| Export | Download `hta-tta.json` (HTA tree + all TTA records) |
| Import | Load a versioned JSON file |
| + Child (**C**) | Add child under selected task |
| + Sibling (**S**) | Add sibling after selected task |
| + Duplicate (**D**) | Duplicate selected task (subtree + TTA) |

Drag the vertical gutter between HTA and TTA to resize panels (saved in `localStorage`). On the HTA canvas, hold **Space** and drag to pan (hand cursor), like Penpot/Figma.

### TTA toolbar

| Control | What it does |
| --- | --- |
| Columns | Show/hide HEI columns (prefs stored in `localStorage`) |
| Filter | Reserved (not yet wired) |
| Export CSV | Download `hta-tta.csv` for Excel / SmartArt |
| Add row | Extra HEI row for the selected task |

### Keyboard

| Keys | Action |
| --- | --- |
| **Space** + drag | Pan the HTA canvas (hand tool) |
| **⌘Z** / **Ctrl+Z** | Undo |
| **⌘⇧Z** / **Ctrl+Shift+Z** (or **Ctrl+Y**) | Redo |
| **↑** | Hover: move to parent (e.g. 1.1.2 → 1.1 → root). Selected: reorder among siblings |
| **↓** | Hover: next task in tree order. Selected: reorder among siblings |
| **←** | Outdent selected task |
| **→** | Indent selected task under previous sibling |
| **C** / **S** / **D** | Child / Sibling / Duplicate |
| **Delete** / **Backspace** | Delete selected task (not root) |
| **Enter** | Start / apply description edit |
| **Esc** | Cancel edit, or clear selection / close column picker |

Hover a task for keyboard focus without selecting; click to select.

### Export CSV (Excel / SmartArt)

TTA **Export CSV** writes UTF-8 CSV (BOM) with columns:

`Depth`, `ID`, `Title`, `Outline`, then HEI fields (External Error Mode, Recovery, Consequence, Human Error Type, PSFs, Comments).

**Outline** is tab-indented with the full hierarchical ID written out, e.g.:

```
1 Operate Train
	1.1 Set Speed
	1.2 Apply Brake
```

Open in Excel, or copy the **Outline** column into Word/PowerPoint as a multilevel list and convert to SmartArt.

### JSON schema (Import / Export)

Version **2** includes `ttaRecords` and column meta:

```json
{
  "version": 2,
  "meta": {
    "theme": "light",
    "columns": [
      { "id": "taskStep", "label": "Task Step", "visible": true, "order": 0 }
    ]
  },
  "root": {
    "id": "1",
    "title": "Root Task",
    "level": 0,
    "children": [
      { "id": "1.1", "title": "Child", "level": 1, "children": [] }
    ]
  },
  "ttaRecords": [
    {
      "id": "r1",
      "taskId": "1.1",
      "externalErrorMode": "",
      "recovery": "",
      "consequence": "",
      "humanErrorType": "",
      "psf": [],
      "comments": ""
    }
  ]
}
```

### Smoke test

```bash
python3 scripts/hta-smoke-test.py
```

---

## HTA Editor (`hta-editor2.html`) — text-panel reference

Earlier state-driven editor (Bowtie-style text panel): [`hta-editor2.html`](hta-editor2.html) + [`scripts/hta-editor-app.js`](scripts/hta-editor-app.js). Tree is source of truth; text panel is a synced authoring view.

- Tab-indented text input; auto-commit after idle
- Undo/Redo (Ctrl/Cmd+Z / Y); Shift+Arrow line selection
- JSON Export/Import (version 1 schema, no TTA)
- Smoke: `python3 scripts/hta-editor-smoke-test.py`

Legacy: [`hta-editor.html`](hta-editor.html). Design file: `HTA.penpot`.

### Example text format (editor2)

```
Root Task
	Subtask 1
		Sub-subtask 1.1
		Sub-subtask 1.2
	Subtask 2
```
