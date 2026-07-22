(function () {
  "use strict";

  const DIAGRAM_VERSION = 1;
  const UPDATE_DEBOUNCE_MS = 3000;
  const HISTORY_LIMIT = 100;

  const hierarchyEl = document.getElementById("hierarchy");
  const connectorsSvg = document.getElementById("connectors");
  const textInput = document.getElementById("textInput");
  const statusMessage = document.getElementById("statusMessage");
  const importFileInput = document.getElementById("import-state-file");

  let state = null;
  const ui = { selectedTaskId: null };
  const taskElements = new Map();

  let history = [];
  let historyIndex = 0;
  let isUndoRedo = false;
  let selectionAnchor = null;
  let currentLinePosition = null;
  let updateTimeout = null;
  let resizeTimeout = null;
  let syncingTextPanel = false;

  // ---------- Status ----------

  function showStatus(message, type = "info") {
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.className = `status-message show ${type}`;
    setTimeout(() => {
      statusMessage.className = "status-message";
    }, type === "error" ? 5000 : 2000);
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
    return {
      version: DIAGRAM_VERSION,
      meta: { theme },
      root,
    };
  }

  // ---------- Serialize / hydrate ----------

  function serializeState(s = state) {
    return {
      version: DIAGRAM_VERSION,
      meta: { theme: s.meta?.theme || "light" },
      root: cloneNode(s.root),
    };
  }

  function hydrateFromDom() {
    const text = textInput?.value ?? "";
    const root = parseHierarchy(text) || {
      id: "1",
      title: "Root Task",
      level: 0,
      children: [],
    };
    const theme = document.body.dataset.theme === "dark" ? "dark" : "light";
    return { version: DIAGRAM_VERSION, meta: { theme }, root };
  }

  // ---------- Theme ----------

  function setTheme(theme) {
    const next = theme === "dark" ? "dark" : "light";
    document.body.dataset.theme = next;
    if (state) state.meta.theme = next;
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

    const taskTitle = document.createElement("div");
    taskTitle.className = "task-title";
    taskTitle.textContent = wrapText(task.title);
    taskTitle.dataset.role = "title";

    taskBox.appendChild(taskTitle);
    taskMain.appendChild(taskId);
    taskMain.appendChild(taskBox);
    taskDiv.appendChild(taskMain);

    taskDiv.addEventListener("click", (e) => {
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
    setTimeout(buildConnectors, 50);
  }

  // ---------- Commit / apply ----------

  function commit(mutator) {
    if (!state) state = hydrateFromDom();
    mutator(state);
    const warnings = validateState(state);
    warnings.forEach((w) => console.warn("[HTA]", w));
    render(state);
    syncTextPanel();
  }

  function applyState(next) {
    ui.selectedTaskId = null;
    state = next;
    setTheme(state.meta?.theme || "light");
    render(state);
    syncTextPanel();
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

  function selectTask(taskId) {
    ui.selectedTaskId = taskId;
    applySelectionUI();
    selectTextLineForTask(taskId);
  }

  function clearSelection() {
    ui.selectedTaskId = null;
    applySelectionUI();
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
    a.download = "hta-hierarchy.json";
    a.click();
    URL.revokeObjectURL(url);
    showStatus("Exported JSON", "success");
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

  document.addEventListener("keydown", (e) => {
    if (document.activeElement === textInput || document.activeElement?.isContentEditable) {
      return;
    }
    if (e.key === "Escape") {
      clearSelection();
      return;
    }
    const key = e.key.toLowerCase();
    const btn = document.querySelector(`[data-shortcut="${key}"]`);
    if (btn && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      runAction(btn.dataset.action);
    }
  });

  window.addEventListener("resize", () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(buildConnectors, 100);
  });

  // ---------- Boot ----------

  state = hydrateFromDom();
  setTheme(state.meta.theme);
  resetHistory(textInput?.value ?? "");
  render(state);

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
  };
})();
