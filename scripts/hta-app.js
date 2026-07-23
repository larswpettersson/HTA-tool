(function () {
  "use strict";

  const DIAGRAM_VERSION = 2;
  const UPDATE_DEBOUNCE_MS = 3000;
  const HISTORY_LIMIT = 100;
  const COLUMN_STORAGE_KEY = "hta-tta-columns";

  const DEFAULT_COLUMNS = [
    { id: "taskStep", label: "Task Step", visible: true, order: 0 },
    { id: "externalErrorMode", label: "External Error Mode", visible: true, order: 1 },
    { id: "recovery", label: "Recovery", visible: true, order: 2 },
    { id: "consequence", label: "Consequence", visible: true, order: 3 },
    { id: "humanErrorType", label: "Human Error Type", visible: true, order: 4 },
    { id: "psf", label: "PSFs", visible: true, order: 5 },
    { id: "comments", label: "Comments", visible: true, order: 6 },
  ];

  const EXTERNAL_ERROR_MODES = [
    "Omission",
    "Action too much",
    "Action too little",
    "Action too late",
    "Action too early",
    "Mis-ordering",
    "Wrong action",
  ];

  const hierarchyEl = document.getElementById("hierarchy");
  const connectorsSvg = document.getElementById("connectors");
  const textInput = document.getElementById("textInput"); // absent in HTA.html
  const statusMessage = document.getElementById("statusMessage");
  const importFileInput = document.getElementById("import-state-file");
  const ttaThead = document.getElementById("ttaThead");
  const ttaTbody = document.getElementById("ttaTbody");
  const columnPicker = document.getElementById("columnPicker");
  const columnPickerList = document.getElementById("columnPickerList");

  let state = null;
  const ui = { selectedTaskId: null, keyboardHoverId: null };
  const taskElements = new Map();

  let history = [];
  let historyIndex = 0;
  let isUndoRedo = false;
  let selectionAnchor = null;
  let currentLinePosition = null;
  let updateTimeout = null;
  let resizeTimeout = null;
  let syncingTextPanel = false;
  let editSession = null;
  let blurNavigation = null; // 'tab' | 'apply' | 'cancel' | null
  let recordIdSeq = 1;

  // ---------- Status ----------

  function showStatus(message, type = "info") {
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.className = `status-message show ${type}`;
    setTimeout(() => {
      statusMessage.className = "status-message";
    }, type === "error" ? 5000 : 2000);
  }

  function readEditableText(el) {
    return (el.innerText ?? el.textContent ?? "").replace(/\r\n?/g, "\n");
  }

  function writeEditableText(el, text) {
    el.textContent = text;
  }

  function isModClick(evt) {
    return !!(evt.metaKey || evt.ctrlKey);
  }

  // ---------- Pure tree helpers ----------

  function wrapText(text, maxChars = 40) {
    if (!text || text.length <= maxChars) return text;
    const words = text.split(" ");
    const lines = [];
    let currentLine = "";
    words.forEach((word) => {
      if ((currentLine + word).length <= maxChars) {
        currentLine += (currentLine ? " " : "") + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    });
    if (currentLine) lines.push(currentLine);
    return lines.join("\n");
  }

  function cloneNode(node) {
    return {
      id: node.id,
      title: node.title,
      level: node.level ?? 0,
      children: (node.children || []).map(cloneNode),
    };
  }

  function findTask(node, id) {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = findTask(child, id);
      if (found) return found;
    }
    return null;
  }

  /** Returns parent node of `id`, or null if `id` is root / not found. */
  function findParentOf(root, id) {
    if (!root || root.id === id) return null;
    for (const child of root.children || []) {
      if (child.id === id) return root;
      const found = findParentOf(child, id);
      if (found) return found;
    }
    return null;
  }

  /** { parent, siblings, index, node } for a non-root task; null if root/missing. */
  function getSiblingContext(root, taskId) {
    const parent = findParentOf(root, taskId);
    if (!parent) return null;
    const siblings = parent.children || [];
    const index = siblings.findIndex((c) => c.id === taskId);
    if (index < 0) return null;
    return { parent, siblings, index, node: siblings[index] };
  }

  function countTasks(node) {
    if (!node) return 0;
    return 1 + (node.children || []).reduce((n, c) => n + countTasks(c), 0);
  }

  function collectLineMap(root) {
    /** Build ordered list of { id, title, lineIndex } from tree walk (pre-order). */
    const map = [];
    function walk(node) {
      if (!node) return;
      map.push({ id: node.id, title: node.title });
      (node.children || []).forEach(walk);
    }
    walk(root);
    return map;
  }

  function parseHierarchy(text) {
    const lines = String(text || "")
      .split("\n")
      .filter((line) => line.trim());
    if (!lines.length) return null;

    const items = lines.map((line) => ({
      indent: line.search(/\S/),
      title: line.trim(),
    }));

    const root = {
      id: "1",
      title: items[0].title,
      level: 0,
      children: [],
    };
    const stack = [{ node: root, indent: items[0].indent }];

    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      while (stack.length > 1 && stack[stack.length - 1].indent >= item.indent) {
        stack.pop();
      }
      const parent = stack[stack.length - 1].node;
      const newId = `${parent.id}.${parent.children.length + 1}`;
      const newNode = {
        id: newId,
        title: item.title,
        level: parent.level + 1,
        children: [],
      };
      parent.children.push(newNode);
      stack.push({ node: newNode, indent: item.indent });
    }
    return root;
  }

  function treeToIndentedText(node, indent = 0) {
    if (!node) return "";
    const lines = [`${"\t".repeat(indent)}${node.title}`];
    for (const child of node.children || []) {
      lines.push(treeToIndentedText(child, indent + 1));
    }
    return lines.join("\n");
  }

  function reassignIds(node, id = "1", level = 0) {
    node.id = id;
    node.level = level;
    (node.children || []).forEach((child, i) => {
      reassignIds(child, `${id}.${i + 1}`, level + 1);
    });
    return node;
  }

  /** Reassign hierarchical ids and remap ttaRecords.taskId to match. */
  function reassignIdsAndRemapTta(s) {
    if (!s?.root) return;
    function stamp(node) {
      node._prevId = node.id;
      (node.children || []).forEach(stamp);
    }
    stamp(s.root);
    reassignIds(s.root);
    const idMap = new Map();
    function unstamp(node) {
      idMap.set(node._prevId, node.id);
      delete node._prevId;
      (node.children || []).forEach(unstamp);
    }
    unstamp(s.root);
    (s.ttaRecords || []).forEach((r) => {
      if (idMap.has(r.taskId)) r.taskId = idMap.get(r.taskId);
    });
  }

  // ---------- Validation ----------

  function validateState(s) {
    const warnings = [];
    if (!s || !s.root) warnings.push("Missing root task.");
    else if (!s.root.title || !String(s.root.title).trim()) {
      warnings.push("Root title is empty.");
    }
    return warnings;
  }

  function validateImportState(s) {
    const errors = [];
    const warnings = [];

    if (!s || typeof s !== "object") {
      errors.push({
        path: "$",
        message: "Import must be a JSON object.",
        fix: 'Provide { "version": 1, "meta": { "theme": "light" }, "root": { "id": "1", "title": "...", "children": [] } }.',
      });
      return { errors, warnings };
    }

    if (s.version != null && Number(s.version) !== DIAGRAM_VERSION) {
      warnings.push({
        path: "version",
        message: `version=${s.version}; expected ${DIAGRAM_VERSION}.`,
        fix: `Set "version": ${DIAGRAM_VERSION}.`,
      });
    }

    if (!s.root || typeof s.root !== "object") {
      errors.push({
        path: "root",
        message: "Missing root task object.",
        fix: 'Add "root": { "id": "1", "title": "Root Task", "children": [] }.',
      });
      return { errors, warnings };
    }

    function walk(node, path) {
      if (!node || typeof node !== "object") {
        errors.push({
          path,
          message: "Task node must be an object.",
          fix: `Replace ${path} with { "title": "...", "children": [] }.`,
        });
        return;
      }
      if (typeof node.title !== "string" || !node.title.trim()) {
        errors.push({
          path: `${path}.title`,
          message: "Task title must be a non-empty string.",
          fix: `Set ${path}.title to a non-empty string.`,
        });
      }
      if (node.children != null && !Array.isArray(node.children)) {
        errors.push({
          path: `${path}.children`,
          message: `children must be an array (got ${typeof node.children}).`,
          fix: `Set ${path}.children to [] or an array of task objects.`,
        });
        return;
      }
      (node.children || []).forEach((child, i) => walk(child, `${path}.children[${i}]`));
    }

    walk(s.root, "root");
    return { errors, warnings };
  }

  function formatImportValidationMessage(errors, warnings) {
    const parts = [];
    if (errors.length) {
      parts.push(`Import blocked (${errors.length} error${errors.length === 1 ? "" : "s"}):\n`);
      errors.forEach((e, i) => {
        parts.push(`${i + 1}. [${e.path}] ${e.message}`);
        if (e.fix) parts.push(`   Fix: ${e.fix}`);
      });
    }
    if (warnings.length) {
      if (parts.length) parts.push("");
      parts.push(`Warnings (${warnings.length}):\n`);
      warnings.forEach((w, i) => {
        parts.push(`${i + 1}. [${w.path}] ${w.message}`);
        if (w.fix) parts.push(`   Fix: ${w.fix}`);
      });
    }
    return parts.join("\n");
  }

  function normalizeImportedState(raw) {
    const theme =
      raw?.meta?.theme === "dark" || raw?.theme === "dark" ? "dark" : "light";
    let root = raw?.root ? cloneNode(raw.root) : null;
    if (!root && typeof raw?.text === "string") {
      root = parseHierarchy(raw.text);
    }
    if (root) reassignIds(root);
    const columns = normalizeColumns(raw?.meta?.columns);
    const ttaRecords = normalizeTtaRecords(raw?.ttaRecords);
    return {
      version: DIAGRAM_VERSION,
      meta: { theme, columns },
      root,
      ttaRecords,
    };
  }

  function normalizeColumns(cols) {
    if (!Array.isArray(cols) || !cols.length) {
      try {
        const cached = JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) || "null");
        if (Array.isArray(cached) && cached.length) {
          return normalizeColumns(cached);
        }
      } catch (_) {
        /* ignore */
      }
      return DEFAULT_COLUMNS.map((c) => ({ ...c }));
    }
    const byId = new Map(cols.map((c) => [c.id, c]));
    return DEFAULT_COLUMNS.map((def, i) => {
      const hit = byId.get(def.id);
      return {
        id: def.id,
        label: def.label,
        visible: hit?.visible !== false,
        order: typeof hit?.order === "number" ? hit.order : i,
      };
    }).sort((a, b) => a.order - b.order);
  }

  function normalizeTtaRecords(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter((r) => r && typeof r === "object")
      .map((r, i) => ({
        id: typeof r.id === "string" && r.id ? r.id : `r${i + 1}`,
        taskId: String(r.taskId || ""),
        externalErrorMode: String(r.externalErrorMode || ""),
        recovery: String(r.recovery || ""),
        consequence: String(r.consequence || ""),
        humanErrorType: String(r.humanErrorType || ""),
        psf: Array.isArray(r.psf)
          ? r.psf.map(String)
          : String(r.psf || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
        comments: String(r.comments || ""),
      }));
  }

  function newRecordId() {
    const id = `r${Date.now().toString(36)}${recordIdSeq++}`;
    return id;
  }

  function sampleSeedState() {
    const root = parseHierarchy(
      "Operate Train\n\tSet Speed\n\tApply Brake"
    );
    reassignIds(root);
    return {
      version: DIAGRAM_VERSION,
      meta: { theme: "light", columns: DEFAULT_COLUMNS.map((c) => ({ ...c })) },
      root,
      ttaRecords: [
        {
          id: "r1",
          taskId: "1.1",
          externalErrorMode: "Action too much",
          recovery: "Auto-cutout",
          consequence: "Overspeed",
          humanErrorType: "Skill-based slip",
          psf: ["Interface"],
          comments: "",
        },
        {
          id: "r2",
          taskId: "1.1",
          externalErrorMode: "Action too late",
          recovery: "Driver prompt",
          consequence: "Late arrival",
          humanErrorType: "Rule-based mistake",
          psf: ["Procedures"],
          comments: "",
        },
        {
          id: "r3",
          taskId: "1.2",
          externalErrorMode: "Omission",
          recovery: "Signal alert",
          consequence: "Signal passed",
          humanErrorType: "Lapse",
          psf: ["Environment"],
          comments: "",
        },
      ],
    };
  }

  // ---------- Serialize / hydrate ----------

  function serializeState(s = state) {
    return {
      version: DIAGRAM_VERSION,
      meta: {
        theme: s.meta?.theme || "light",
        columns: (s.meta?.columns || DEFAULT_COLUMNS).map((c) => ({ ...c })),
      },
      root: cloneNode(s.root),
      ttaRecords: (s.ttaRecords || []).map((r) => ({
        ...r,
        psf: [...(r.psf || [])],
      })),
    };
  }

  function hydrateFromDom() {
    if (textInput?.value?.trim()) {
      const root = parseHierarchy(textInput.value);
      const theme = document.body.dataset.theme === "dark" ? "dark" : "light";
      return {
        version: DIAGRAM_VERSION,
        meta: { theme, columns: DEFAULT_COLUMNS.map((c) => ({ ...c })) },
        root,
        ttaRecords: [],
      };
    }
    const seed = sampleSeedState();
    const theme = document.body.dataset.theme === "dark" ? "dark" : "light";
    seed.meta.theme = theme;
    return seed;
  }

  // ---------- Theme ----------

  function setTheme(theme) {
    const next = theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = next;
    if (state) state.meta.theme = next;
  }

  // ---------- Edit session (Bowtie parity) ----------

  function startEditSession(el, getValue, setValue) {
    editSession = { el, originalValue: getValue(), getValue, setValue };
  }

  function applyEditSession() {
    if (!editSession) return;
    const { el, setValue } = editSession;
    const value = readEditableText(el);
    el.dataset.full = value;
    setValue(value);
    editSession = null;
    commit(() => {});
  }

  function cancelEditSession() {
    if (!editSession) return;
    const { el, originalValue, setValue } = editSession;
    setValue(originalValue);
    el.dataset.full = originalValue;
    writeEditableText(el, originalValue);
    editSession = null;
    commit(() => {});
  }

  function isEditContextSelected(el) {
    const taskEl = el.closest(".task");
    if (!taskEl) return false;
    return ui.selectedTaskId === taskEl.dataset.taskId;
  }

  function handleEditBlur(el) {
    if (!editSession || editSession.el !== el) return;
    if (blurNavigation === "cancel" || blurNavigation === "apply") {
      blurNavigation = null;
      return;
    }

    if (blurNavigation === "tab" && isEditContextSelected(el)) {
      const related = document.activeElement;
      const leaving = el.closest(".task");
      const entering = related?.closest?.(".task");
      const tabWithinSame =
        leaving && entering && leaving.dataset.taskId === entering.dataset.taskId;

      if (tabWithinSame) {
        const value = readEditableText(el);
        el.dataset.full = value;
        editSession.setValue(value);
        editSession = null;
      } else {
        cancelEditSession();
      }
      blurNavigation = null;
      return;
    }

    applyEditSession();
    blurNavigation = null;
  }

  function beginFieldEdit(taskEl, role = "description") {
    if (!taskEl) return;
    const field = taskEl.querySelector(`[data-role="${role}"]`);
    if (!field) return;
    clearKeyboardHover();
    taskEl.classList.remove("selected");
    ui.selectedTaskId = null;
    field.focus();
  }

  function finishEditingAfterApply(taskId) {
    if (!taskId) return;
    selectTask(taskId, { skipTextFocus: true });
  }

  function clearKeyboardHover() {
    ui.keyboardHoverId = null;
    document.querySelectorAll(".task.is-keyboard-hover").forEach((el) => {
      el.classList.remove("is-keyboard-hover");
    });
  }

  function applyKeyboardHoverUI() {
    document.querySelectorAll(".task.is-keyboard-hover").forEach((el) => {
      el.classList.remove("is-keyboard-hover");
    });
    if (!ui.keyboardHoverId) return;
    const el = taskElements.get(ui.keyboardHoverId);
    if (el) el.classList.add("is-keyboard-hover");
  }

  function setKeyboardNavTarget(taskEl, { select = false } = {}) {
    if (!taskEl) return;
    const id = taskEl.dataset.taskId;
    ui.keyboardHoverId = id;
    if (select) {
      ui.selectedTaskId = id;
    } else {
      ui.selectedTaskId = null;
    }
    applySelectionUI();
    applyKeyboardHoverUI();
  }

  function getTaskElsInOrder() {
    return collectLineMap(state?.root)
      .map((entry) => taskElements.get(entry.id))
      .filter(Boolean);
  }

  function navigateTasks(key) {
    const tasks = getTaskElsInOrder();
    if (!tasks.length) return;
    const current =
      document.querySelector(".task.is-keyboard-hover") ||
      (ui.selectedTaskId ? taskElements.get(ui.selectedTaskId) : null);
    let index = current ? tasks.indexOf(current) : -1;
    if (key === "ArrowUp") {
      index = index <= 0 ? 0 : index - 1;
    } else if (key === "ArrowDown") {
      index = index < 0 ? 0 : Math.min(tasks.length - 1, index + 1);
    } else {
      return;
    }
    setKeyboardNavTarget(tasks[index], { select: false });
  }

  /** Hover: ←→ move keyboard hover among siblings (same level). */
  function navigateSiblingHover(direction) {
    const hoverId = ui.keyboardHoverId;
    if (!hoverId || !state?.root) return false;
    const ctx = getSiblingContext(state.root, hoverId);
    if (!ctx) return false;
    const next = ctx.index + direction;
    if (next < 0 || next >= ctx.siblings.length) return false;
    const nextEl = taskElements.get(ctx.siblings[next].id);
    if (!nextEl) return false;
    setKeyboardNavTarget(nextEl, { select: false });
    return true;
  }

  /** Selected: ←→ reorder task + subtree among siblings at same level. */
  function moveSelectedAmongSiblings(direction) {
    const selectedId = ui.selectedTaskId;
    if (!selectedId || !state?.root) return false;
    let movedNode = null;
    commit((s) => {
      const ctx = getSiblingContext(s.root, selectedId);
      if (!ctx) return;
      const next = ctx.index + direction;
      if (next < 0 || next >= ctx.siblings.length) return;
      movedNode = ctx.siblings[ctx.index];
      ctx.siblings.splice(ctx.index, 1);
      ctx.siblings.splice(next, 0, movedNode);
      reassignIdsAndRemapTta(s);
      ui.selectedTaskId = movedNode.id;
    });
    if (!movedNode) return false;
    selectTask(movedNode.id, { skipTextFocus: true });
    return true;
  }

  function handleHorizontalArrow(key) {
    const direction = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (!direction) return false;
    if (ui.selectedTaskId) return moveSelectedAmongSiblings(direction);
    if (ui.keyboardHoverId) return navigateSiblingHover(direction);
    return false;
  }

  function handleEnterOnComponent(evt) {
    if (evt.key !== "Enter" || evt.shiftKey) return false;
    const current =
      document.querySelector(".task.is-keyboard-hover") ||
      (ui.selectedTaskId ? taskElements.get(ui.selectedTaskId) : null);
    if (!current) return false;
    evt.preventDefault();
    if (evt.metaKey || evt.ctrlKey) {
      selectTask(current.dataset.taskId, { skipTextFocus: true });
      return true;
    }
    beginFieldEdit(current, "description");
    return true;
  }

  function wireDescriptionEditing(el, taskId) {
    el.addEventListener("mousedown", (evt) => {
      if (isModClick(evt)) {
        evt.preventDefault();
        selectTask(taskId);
      }
    });

    el.addEventListener("focus", () => {
      writeEditableText(el, el.dataset.full || readEditableText(el));
      startEditSession(
        el,
        () => {
          const node = findTask(state.root, taskId);
          return node?.title ?? el.dataset.full ?? "";
        },
        (value) => {
          const node = findTask(state.root, taskId);
          if (node) node.title = value;
          el.dataset.full = value;
        }
      );
      clearKeyboardHover();
      const taskEl = el.closest(".task");
      if (taskEl) taskEl.classList.remove("selected");
      ui.selectedTaskId = null;
    });

    el.addEventListener("blur", () => handleEditBlur(el));

    el.addEventListener("input", () => {
      el.dataset.full = readEditableText(el);
    });
  }

  // ---------- Render ----------

  function createTaskElement(task) {
    const taskDiv = document.createElement("div");
    taskDiv.className = "task";
    taskDiv.dataset.taskId = task.id;

    const taskMain = document.createElement("div");
    taskMain.className = "task-main";

    const taskId = document.createElement("div");
    taskId.className = "task-id";
    taskId.textContent = task.id;
    taskId.dataset.role = "id";

    const taskBox = document.createElement("div");
    taskBox.className = "task-box";

    const desc = document.createElement("div");
    desc.className = "desc-text";
    desc.contentEditable = "true";
    desc.spellcheck = false;
    desc.dataset.role = "description";
    desc.dataset.full = task.title;
    writeEditableText(desc, wrapText(task.title));
    wireDescriptionEditing(desc, task.id);

    taskBox.appendChild(desc);
    taskMain.appendChild(taskId);
    taskMain.appendChild(taskBox);
    taskDiv.appendChild(taskMain);

    taskDiv.addEventListener("click", (e) => {
      if (e.target.closest(".desc-text")) return;
      e.stopPropagation();
      selectTask(task.id);
    });

    taskElements.set(task.id, taskDiv);
    return taskDiv;
  }

  function buildConnectors() {
    if (!connectorsSvg || !state?.root) return;
    connectorsSvg.innerHTML = "";
    const hierarchyRect = hierarchyEl.getBoundingClientRect();

    taskElements.forEach((parentEl, parentId) => {
      const parentTask = findTask(state.root, parentId);
      if (!parentTask?.children?.length) return;

      const parentBox = parentEl.querySelector(".task-box")?.getBoundingClientRect();
      if (!parentBox) return;
      const parentCenterX = parentBox.left + parentBox.width / 2 - hierarchyRect.left;
      const parentBottom = parentBox.bottom - hierarchyRect.top;

      parentTask.children.forEach((child) => {
        const childEl = taskElements.get(child.id);
        if (!childEl) return;
        const childBox = childEl.querySelector(".task-box")?.getBoundingClientRect();
        if (!childBox) return;
        const childCenterX = childBox.left + childBox.width / 2 - hierarchyRect.left;
        const childTop = childBox.top - hierarchyRect.top;
        const midY = parentBottom + (childTop - parentBottom) / 2;

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute(
          "d",
          `M ${parentCenterX} ${parentBottom} L ${parentCenterX} ${midY} L ${childCenterX} ${midY} L ${childCenterX} ${childTop}`
        );
        path.setAttribute("class", "connector-line");
        connectorsSvg.appendChild(path);
      });
    });
  }

  function syncTextPanel() {
    if (!textInput || !state?.root) return;
    if (document.activeElement === textInput) return;
    syncingTextPanel = true;
    const next = treeToIndentedText(state.root);
    if (textInput.value !== next) {
      textInput.value = next;
      resetHistory(next);
    }
    syncingTextPanel = false;
  }

  function visibleColumns() {
    return (state?.meta?.columns || DEFAULT_COLUMNS)
      .slice()
      .sort((a, b) => a.order - b.order)
      .filter((c) => c.visible !== false);
  }

  function persistColumns() {
    try {
      localStorage.setItem(
        COLUMN_STORAGE_KEY,
        JSON.stringify(state.meta.columns || [])
      );
    } catch (_) {
      /* ignore */
    }
  }

  function orderedTtaRows() {
    if (!state?.root) return [];
    const order = new Map();
    collectLineMap(state.root).forEach((entry, i) => order.set(entry.id, i));
    const records = [...(state.ttaRecords || [])];
    records.sort((a, b) => {
      const oa = order.has(a.taskId) ? order.get(a.taskId) : Number.MAX_SAFE_INTEGER;
      const ob = order.has(b.taskId) ? order.get(b.taskId) : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return String(a.id).localeCompare(String(b.id));
    });
    return records;
  }

  function taskRefFor(taskId) {
    const node = findTask(state?.root, taskId);
    if (!node) return taskId || "";
    return `${node.id} ${node.title}`;
  }

  function renderTta() {
    if (!ttaThead || !ttaTbody || !state) return;
    const cols = visibleColumns();
    ttaThead.innerHTML = "";
    const trh = document.createElement("tr");
    cols.forEach((col) => {
      const th = document.createElement("th");
      th.dataset.col = col.id;
      th.textContent = col.label;
      trh.appendChild(th);
    });
    ttaThead.appendChild(trh);

    ttaTbody.innerHTML = "";
    orderedTtaRows().forEach((rec) => {
      const tr = document.createElement("tr");
      tr.dataset.recordId = rec.id;
      tr.dataset.taskId = rec.taskId;
      if (ui.selectedTaskId && rec.taskId === ui.selectedTaskId) {
        tr.classList.add("is-selected");
      }
      tr.addEventListener("click", (e) => {
        if (e.target.closest("[contenteditable], select")) return;
        selectTask(rec.taskId, { skipTextFocus: true });
      });

      cols.forEach((col) => {
        const td = document.createElement("td");
        td.dataset.col = col.id;
        if (col.id === "taskStep") {
          td.className = "tta-task-ref";
          td.textContent = taskRefFor(rec.taskId);
        } else if (col.id === "externalErrorMode") {
          const sel = document.createElement("select");
          sel.innerHTML = EXTERNAL_ERROR_MODES.map(
            (m) =>
              `<option value="${m}"${m === rec.externalErrorMode ? " selected" : ""}>${m}</option>`
          ).join("");
          if (
            rec.externalErrorMode &&
            !EXTERNAL_ERROR_MODES.includes(rec.externalErrorMode)
          ) {
            const opt = document.createElement("option");
            opt.value = rec.externalErrorMode;
            opt.selected = true;
            opt.textContent = rec.externalErrorMode;
            sel.appendChild(opt);
          }
          sel.addEventListener("change", () => {
            rec.externalErrorMode = sel.value;
            commit(() => {});
          });
          td.appendChild(sel);
        } else if (col.id === "psf") {
          td.contentEditable = "true";
          td.spellcheck = false;
          td.textContent = (rec.psf || []).join(", ");
          td.addEventListener("blur", () => {
            rec.psf = readEditableText(td)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            commit(() => {});
          });
        } else {
          const key = col.id;
          td.contentEditable = "true";
          td.spellcheck = false;
          td.textContent = rec[key] || "";
          td.addEventListener("blur", () => {
            rec[key] = readEditableText(td);
            commit(() => {});
          });
        }
        tr.appendChild(td);
      });
      ttaTbody.appendChild(tr);
    });

    renderColumnPicker();
  }

  function renderColumnPicker() {
    if (!columnPickerList || !state?.meta?.columns) return;
    columnPickerList.innerHTML = "";
    state.meta.columns
      .slice()
      .sort((a, b) => a.order - b.order)
      .forEach((col) => {
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = col.visible !== false;
        cb.addEventListener("change", () => {
          col.visible = cb.checked;
          persistColumns();
          renderTta();
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(col.label));
        columnPickerList.appendChild(label);
      });
  }

  function highlightTtaForTask(taskId) {
    if (!ttaTbody) return;
    let first = null;
    ttaTbody.querySelectorAll("tr").forEach((tr) => {
      const on = taskId && tr.dataset.taskId === taskId;
      tr.classList.toggle("is-selected", on);
      if (on && !first) first = tr;
    });
    if (first) {
      first.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function applySelectionUI() {
    document.querySelectorAll(".task").forEach((el) => el.classList.remove("selected"));
    if (!ui.selectedTaskId) return;
    const el = taskElements.get(ui.selectedTaskId);
    if (el) el.classList.add("selected");
  }

  function render(s = state) {
    if (!hierarchyEl || !s?.root) return;
    taskElements.clear();
    Array.from(hierarchyEl.children).forEach((child) => {
      if (child.id !== "connectors") child.remove();
    });

    function renderNode(node, container) {
      const nodeGroup = document.createElement("div");
      nodeGroup.className = "node-group";

      const nodeDiv = document.createElement("div");
      nodeDiv.className = "node";
      nodeDiv.appendChild(createTaskElement(node));

      if (node.children?.length) {
        const childrenDiv = document.createElement("div");
        childrenDiv.className = "node-children";
        node.children.forEach((child) => {
          const childContainer = document.createElement("div");
          renderNode(child, childContainer);
          childrenDiv.appendChild(childContainer);
        });
        nodeGroup.appendChild(nodeDiv);
        nodeGroup.appendChild(childrenDiv);
      } else {
        nodeGroup.appendChild(nodeDiv);
      }
      container.appendChild(nodeGroup);
    }

    renderNode(s.root, hierarchyEl);
    applySelectionUI();
    applyKeyboardHoverUI();
    renderTta();
    setTimeout(buildConnectors, 50);
  }

  // ---------- Commit / apply ----------

  function applyState(next) {
    ui.selectedTaskId = null;
    clearKeyboardHover();
    if (!next.ttaRecords) next.ttaRecords = [];
    if (!next.meta) next.meta = {};
    if (!next.meta.columns) next.meta.columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));
    state = next;
    setTheme(state.meta?.theme || "light");
    render(state);
    syncTextPanel();
    updateToolbarEnabled();
  }

  function commit(mutator) {
    if (!state) state = hydrateFromDom();
    if (!state.ttaRecords) state.ttaRecords = [];
    if (!state.meta) state.meta = { theme: "light" };
    if (!state.meta.columns) state.meta.columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));
    mutator(state);
    const warnings = validateState(state);
    warnings.forEach((w) => console.warn("[HTA]", w));
    render(state);
    syncTextPanel();
    updateToolbarEnabled();
  }

  function loadState(raw) {
    const normalized = normalizeImportedState(raw);
    const { errors, warnings } = validateImportState(normalized);
    if (errors.length) {
      const msg = formatImportValidationMessage(errors, warnings);
      window.alert(msg);
      showStatus("Import blocked", "error");
      return false;
    }
    if (warnings.length) {
      const ok = window.confirm(
        `${formatImportValidationMessage([], warnings)}\n\nImport anyway?`
      );
      if (!ok) return false;
    }
    applyState(normalized);
    showStatus("Hierarchy imported", "success");
    return true;
  }

  // ---------- Selection (id ↔ line) ----------

  function selectTextLineForTask(taskId) {
    if (!textInput || !state?.root) return;
    const lineMap = collectLineMap(state.root);
    const index = lineMap.findIndex((entry) => entry.id === taskId);
    if (index < 0) return;

    const lines = textInput.value.split("\n");
    // Align with non-empty lines used by parse — walk raw lines skipping blanks
    let nonEmptyIdx = -1;
    let rawLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      nonEmptyIdx += 1;
      if (nonEmptyIdx === index) {
        rawLineIndex = i;
        break;
      }
    }
    if (rawLineIndex < 0) return;

    const startPos =
      lines.slice(0, rawLineIndex).join("\n").length + (rawLineIndex > 0 ? 1 : 0);
    const endPos = startPos + lines[rawLineIndex].length;
    textInput.focus();
    textInput.setSelectionRange(startPos, endPos);
    const lineHeight = parseInt(window.getComputedStyle(textInput).lineHeight, 10) || 20;
    textInput.scrollTop = Math.max(0, rawLineIndex * lineHeight - textInput.clientHeight / 2);
  }

  function selectTask(taskId, { skipTextFocus = false } = {}) {
    clearKeyboardHover();
    ui.selectedTaskId = taskId;
    applySelectionUI();
    highlightTtaForTask(taskId);
    if (!skipTextFocus) selectTextLineForTask(taskId);
    updateToolbarEnabled();
  }

  function clearSelection() {
    ui.selectedTaskId = null;
    clearKeyboardHover();
    applySelectionUI();
    highlightTtaForTask(null);
    updateToolbarEnabled();
  }

  function activeTaskId() {
    return ui.selectedTaskId || ui.keyboardHoverId || null;
  }

  function updateToolbarEnabled() {
    const id = activeTaskId();
    const siblingBtn = document.querySelector('[data-action="addSibling"]');
    if (siblingBtn) siblingBtn.disabled = !id || id === state?.root?.id;
  }

  function collectSubtreeIds(node, out = []) {
    if (!node) return out;
    out.push(node.id);
    (node.children || []).forEach((c) => collectSubtreeIds(c, out));
    return out;
  }

  function addChildTask() {
    const id = activeTaskId() || state?.root?.id;
    if (!id || !state?.root) return;
    let created = null;
    commit((s) => {
      const parent = findTask(s.root, id);
      if (!parent) return;
      if (!parent.children) parent.children = [];
      created = {
        id: "tmp",
        title: "New task",
        level: (parent.level || 0) + 1,
        children: [],
      };
      parent.children.push(created);
      reassignIdsAndRemapTta(s);
    });
    if (created) selectTask(created.id, { skipTextFocus: true });
  }

  function addSiblingTask() {
    const id = activeTaskId();
    if (!id || !state?.root || id === state.root.id) {
      showStatus("Root has no sibling", "error");
      return;
    }
    let created = null;
    commit((s) => {
      const parent = findParentOf(s.root, id);
      if (!parent) return;
      const idx = parent.children.findIndex((c) => c.id === id);
      if (idx < 0) return;
      created = {
        id: "tmp",
        title: "New task",
        level: (parent.level || 0) + 1,
        children: [],
      };
      parent.children.splice(idx + 1, 0, created);
      reassignIdsAndRemapTta(s);
    });
    if (created) selectTask(created.id, { skipTextFocus: true });
  }

  function duplicateTask() {
    const id = activeTaskId();
    if (!id || !state?.root) return;
    if (id === state.root.id) {
      showStatus("Duplicate root is not supported", "error");
      return;
    }
    let dupRoot = null;
    commit((s) => {
      const parent = findParentOf(s.root, id);
      const node = findTask(s.root, id);
      if (!parent || !node) return;
      const idx = parent.children.findIndex((c) => c.id === id);
      if (idx < 0) return;

      function cloneFresh(src) {
        return {
          id: "tmp",
          title: src.title,
          level: src.level,
          children: (src.children || []).map(cloneFresh),
          _srcId: src.id,
        };
      }

      dupRoot = cloneFresh(node);
      parent.children.splice(idx + 1, 0, dupRoot);

      const copies = [];
      function collectCopies(n) {
        (s.ttaRecords || []).forEach((r) => {
          if (r.taskId === n._srcId) {
            copies.push({
              id: newRecordId(),
              taskId: null,
              externalErrorMode: r.externalErrorMode,
              recovery: r.recovery,
              consequence: r.consequence,
              humanErrorType: r.humanErrorType,
              psf: [...(r.psf || [])],
              comments: r.comments,
              _bind: n,
            });
          }
        });
        (n.children || []).forEach(collectCopies);
      }
      collectCopies(dupRoot);

      reassignIdsAndRemapTta(s);

      copies.forEach((c) => {
        c.taskId = c._bind.id;
        delete c._bind;
      });
      s.ttaRecords = [...(s.ttaRecords || []), ...copies];

      function scrub(n) {
        delete n._srcId;
        (n.children || []).forEach(scrub);
      }
      scrub(s.root);
      dupRoot = parent.children[idx + 1];
    });
    if (dupRoot) selectTask(dupRoot.id, { skipTextFocus: true });
  }

  function deleteSelectedTask() {
    const id = ui.selectedTaskId;
    if (!id || !state?.root) return;
    if (id === state.root.id) {
      showStatus("Cannot delete root task", "error");
      return;
    }
    commit((s) => {
      const parent = findParentOf(s.root, id);
      const node = findTask(s.root, id);
      if (!parent || !node) return;
      const removed = new Set(collectSubtreeIds(node));
      parent.children = parent.children.filter((c) => c.id !== id);
      s.ttaRecords = (s.ttaRecords || []).filter((r) => !removed.has(r.taskId));
      reassignIdsAndRemapTta(s);
    });
    clearSelection();
  }

  function addTtaRow() {
    const taskId = activeTaskId();
    if (!taskId) {
      showStatus("Select a task first", "error");
      return;
    }
    commit((s) => {
      if (!s.ttaRecords) s.ttaRecords = [];
      s.ttaRecords.push({
        id: newRecordId(),
        taskId,
        externalErrorMode: "Omission",
        recovery: "",
        consequence: "",
        humanErrorType: "",
        psf: [],
        comments: "",
      });
    });
    selectTask(taskId, { skipTextFocus: true });
  }

  function toggleColumnPicker() {
    columnPicker?.classList.toggle("open");
  }

  function resetColumns() {
    if (!state) return;
    state.meta.columns = DEFAULT_COLUMNS.map((c) => ({ ...c }));
    persistColumns();
    renderTta();
    showStatus("Columns reset", "success");
  }

  // ---------- Text history ----------

  function resetHistory(value) {
    history = [value];
    historyIndex = 0;
  }

  function saveHistory() {
    if (isUndoRedo || syncingTextPanel) return;
    history = history.slice(0, historyIndex + 1);
    history.push(textInput.value);
    historyIndex += 1;
    if (history.length > HISTORY_LIMIT) {
      history.shift();
      historyIndex -= 1;
    }
  }

  function scheduleCommitFromText() {
    if (updateTimeout) clearTimeout(updateTimeout);
    updateTimeout = setTimeout(() => {
      commitFromText();
    }, UPDATE_DEBOUNCE_MS);
  }

  function commitFromText() {
    const text = textInput.value;
    if (!text.trim()) {
      showStatus("Please enter some text", "error");
      return;
    }
    const root = parseHierarchy(text);
    if (!root) {
      showStatus("Failed to parse hierarchy", "error");
      return;
    }
    commit((s) => {
      s.root = root;
    });
    showStatus("Hierarchy updated", "success");
  }

  function undo() {
    if (historyIndex <= 0) return;
    isUndoRedo = true;
    historyIndex -= 1;
    textInput.value = history[historyIndex];
    isUndoRedo = false;
    scheduleCommitFromText();
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    isUndoRedo = true;
    historyIndex += 1;
    textInput.value = history[historyIndex];
    isUndoRedo = false;
    scheduleCommitFromText();
  }

  function getLineStart(text, pos) {
    let start = pos;
    while (start > 0 && text[start - 1] !== "\n") start -= 1;
    return start;
  }

  function getLineEnd(text, pos) {
    let end = pos;
    while (end < text.length && text[end] !== "\n") end += 1;
    return end;
  }

  // ---------- Import / export ----------

  function exportStateToFile() {
    const payload = serializeState();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "hta-tta.json";
    a.click();
    URL.revokeObjectURL(url);
    showStatus("Exported HTA+TTA JSON", "success");
  }

  function importStateFromFile() {
    importFileInput?.click();
  }

  // ---------- Actions / keyboard ----------

  const actions = {
    setThemeLight: () => setTheme("light"),
    setThemeDark: () => setTheme("dark"),
    exportState: () => exportStateToFile(),
    importState: () => importStateFromFile(),
    addChild: () => addChildTask(),
    addSibling: () => addSiblingTask(),
    duplicateTask: () => duplicateTask(),
    addTtaRow: () => addTtaRow(),
    toggleColumnPicker: () => toggleColumnPicker(),
    resetColumns: () => resetColumns(),
  };

  function runAction(name) {
    const fn = actions[name];
    if (fn) fn();
  }

  // ---------- Wire events ----------

  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => runAction(btn.dataset.action));
  });

  importFileInput?.addEventListener("change", async () => {
    const file = importFileInput.files?.[0];
    importFileInput.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text);
      loadState(raw);
    } catch (err) {
      window.alert(`Import failed: ${err.message}`);
      showStatus("Import failed", "error");
    }
  });

  hierarchyEl?.addEventListener("click", (e) => {
    if (e.target.id === "hierarchy" || e.target.id === "connectors") {
      clearSelection();
    }
  });

  hierarchyEl?.addEventListener("mousedown", (e) => {
    if (isModClick(e) && e.target.closest(".desc-text")) {
      e.preventDefault();
    }
  });

  textInput?.addEventListener("keydown", (e) => {
    const start = e.target.selectionStart;
    const end = e.target.selectionEnd;
    const value = e.target.value;

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
      e.preventDefault();
      redo();
      return;
    }

    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (selectionAnchor === null) {
        selectionAnchor = getLineStart(value, start);
        currentLinePosition = selectionAnchor;
      }
      if (e.key === "ArrowUp") {
        if (currentLinePosition > 0) {
          currentLinePosition = getLineStart(value, currentLinePosition - 1);
        }
      } else {
        const lineEnd = getLineEnd(value, currentLinePosition);
        if (lineEnd < value.length && value[lineEnd] === "\n") {
          currentLinePosition = lineEnd + 1;
        } else if (lineEnd < value.length) {
          currentLinePosition = lineEnd;
        }
      }
      let newStart;
      let newEnd;
      if (currentLinePosition < selectionAnchor) {
        newStart = currentLinePosition;
        newEnd = getLineEnd(value, selectionAnchor);
      } else {
        newStart = selectionAnchor;
        newEnd = getLineEnd(value, currentLinePosition);
      }
      e.target.selectionStart = newStart;
      e.target.selectionEnd = newEnd;
      return;
    }

    if (!e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) {
      selectionAnchor = null;
      currentLinePosition = null;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      const lineStart = getLineStart(value, start);
      const lineEnd = getLineEnd(value, end);
      const selectedText = value.substring(lineStart, lineEnd);
      const lines = selectedText.split("\n");
      let newText;
      let offset;
      if (e.shiftKey) {
        newText = lines.map((line) => (line.startsWith("\t") ? line.slice(1) : line)).join("\n");
        offset = selectedText.length - newText.length;
      } else {
        newText = lines.map((line) => `\t${line}`).join("\n");
        offset = newText.length - selectedText.length;
      }
      e.target.value = value.substring(0, lineStart) + newText + value.substring(lineEnd);
      if (start === end) {
        const newCursorPos = e.shiftKey ? Math.max(lineStart, start - 1) : start + 1;
        e.target.selectionStart = e.target.selectionEnd = newCursorPos;
      } else {
        e.target.selectionStart = lineStart;
        e.target.selectionEnd = e.shiftKey ? lineEnd - offset : lineEnd + offset;
      }
      saveHistory();
      scheduleCommitFromText();
    }
  });

  textInput?.addEventListener("input", () => {
    if (syncingTextPanel) return;
    saveHistory();
    scheduleCommitFromText();
  });

  textInput?.addEventListener("mousedown", () => {
    selectionAnchor = null;
    currentLinePosition = null;
  });
  textInput?.addEventListener("click", () => {
    selectionAnchor = null;
    currentLinePosition = null;
  });

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab") blurNavigation = "tab";
    },
    true
  );

  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;

    if (active?.isContentEditable && hierarchyEl?.contains(active)) {
      if (e.key === "Escape") {
        e.preventDefault();
        const taskId = active.closest(".task")?.dataset.taskId;
        blurNavigation = "cancel";
        cancelEditSession();
        active.blur();
        if (taskId) {
          const el = taskElements.get(taskId);
          if (el) setKeyboardNavTarget(el, { select: false });
        }
        return;
      }

      if (e.key === "Enter") {
        const isDesc = active.classList.contains("desc-text");
        if (isDesc && e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
        e.preventDefault();
        const taskId = active.closest(".task")?.dataset.taskId;
        blurNavigation = "apply";
        applyEditSession();
        active.blur();
        if (e.metaKey || e.ctrlKey) {
          if (taskId) selectTask(taskId, { skipTextFocus: true });
        } else {
          finishEditingAfterApply(taskId);
        }
      }
      return;
    }

    if (active === textInput) return;

    if (e.key === "Enter" && !e.shiftKey) {
      if (handleEnterOnComponent(e)) return;
    }

    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      e.preventDefault();
      navigateTasks(e.key);
      return;
    }

    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (handleHorizontalArrow(e.key)) {
        e.preventDefault();
      }
      return;
    }

    if (e.key === "Escape") {
      columnPicker?.classList.remove("open");
      clearSelection();
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (document.activeElement?.isContentEditable) return;
      if (document.activeElement?.tagName === "SELECT") return;
      if (document.activeElement?.tagName === "INPUT") return;
      if (!ui.selectedTaskId) return;
      e.preventDefault();
      deleteSelectedTask();
      return;
    }

    const key = e.key.toLowerCase();
    const btn = document.querySelector(`[data-shortcut="${key}"]`);
    if (btn && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      runAction(btn.dataset.action);
    }
  });

  document.addEventListener("click", (e) => {
    if (
      columnPicker?.classList.contains("open") &&
      !e.target.closest("#columnPicker") &&
      !e.target.closest('[data-action="toggleColumnPicker"]')
    ) {
      columnPicker.classList.remove("open");
    }
  });

  window.addEventListener("resize", () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(buildConnectors, 100);
  });

  // ---------- Boot ----------

  state = hydrateFromDom();
  setTheme(state.meta.theme);
  if (textInput) resetHistory(textInput.value ?? "");
  render(state);
  updateToolbarEnabled();

  // Expose for smoke tests / debugging
  window.HTAEditor = {
    getState: () => serializeState(),
    loadState,
    parseHierarchy,
    treeToIndentedText,
    validateImportState,
    normalizeImportedState,
    formatImportValidationMessage,
    commitFromText,
    countTasks,
    orderedTtaRows,
    addChildTask,
    addSiblingTask,
    duplicateTask,
    deleteSelectedTask,
  };
})();
