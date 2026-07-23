#!/usr/bin/env python3
"""Static + logic smoke tests for hta-editor2 state refactor (no browser required)."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
HTA_HTML = ROOT / "hta-editor2.html"
APP_JS = ROOT / "scripts" / "hta-editor-app.js"
LEGACY_HTML = ROOT / "hta-editor.html"
SAMPLE = ROOT / "fixtures" / "hta-sample.json"
BROKEN = ROOT / "fixtures" / "hta-broken.json"


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def assert_contains(label: str, haystack: str, needle: str) -> None:
    assert_true(needle in haystack, f"{label}: expected to contain {needle!r}")


def assert_not_contains(label: str, haystack: str, needle: str) -> None:
    assert_true(needle not in haystack, f"{label}: expected NOT to contain {needle!r}")


def parse_hierarchy(text: str) -> dict[str, Any] | None:
    lines = [ln for ln in text.split("\n") if ln.strip()]
    if not lines:
        return None
    items = [{"indent": len(ln) - len(ln.lstrip()), "title": ln.strip()} for ln in lines]
    # Prefer tab indent like the JS (search(/\S/)); approximate with leading whitespace length
    items = []
    for ln in lines:
        m = re.match(r"^(\s*)(\S.*)$", ln)
        if not m:
            continue
        items.append({"indent": len(m.group(1)), "title": m.group(2)})
    if not items:
        return None

    root: dict[str, Any] = {
        "id": "1",
        "title": items[0]["title"],
        "level": 0,
        "children": [],
    }
    stack: list[dict[str, Any]] = [{"node": root, "indent": items[0]["indent"]}]
    for item in items[1:]:
        while len(stack) > 1 and stack[-1]["indent"] >= item["indent"]:
            stack.pop()
        parent = stack[-1]["node"]
        new_id = f"{parent['id']}.{len(parent['children']) + 1}"
        new_node = {
            "id": new_id,
            "title": item["title"],
            "level": parent["level"] + 1,
            "children": [],
        }
        parent["children"].append(new_node)
        stack.append({"node": new_node, "indent": item["indent"]})
    return root


def tree_to_indented_text(node: dict[str, Any], indent: int = 0) -> str:
    lines = ["\t" * indent + node["title"]]
    for child in node.get("children") or []:
        lines.append(tree_to_indented_text(child, indent + 1))
    return "\n".join(lines)


def count_tasks(node: dict[str, Any] | None) -> int:
    if not node:
        return 0
    return 1 + sum(count_tasks(c) for c in node.get("children") or [])


def validate_import_state(s: Any) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if not isinstance(s, dict):
        errors.append(
            {
                "path": "$",
                "message": "Import must be a JSON object.",
                "fix": "Provide a root object.",
            }
        )
        return errors, warnings
    if "root" not in s or not isinstance(s.get("root"), dict):
        errors.append(
            {
                "path": "root",
                "message": "Missing root task object.",
                "fix": 'Add "root": { "title": "...", "children": [] }.',
            }
        )
        return errors, warnings

    def walk(node: Any, path: str) -> None:
        if not isinstance(node, dict):
            errors.append(
                {
                    "path": path,
                    "message": "Task node must be an object.",
                    "fix": f"Replace {path} with an object.",
                }
            )
            return
        title = node.get("title")
        if not isinstance(title, str) or not title.strip():
            errors.append(
                {
                    "path": f"{path}.title",
                    "message": "Task title must be a non-empty string.",
                    "fix": f"Set {path}.title to a non-empty string.",
                }
            )
        children = node.get("children")
        if children is not None and not isinstance(children, list):
            errors.append(
                {
                    "path": f"{path}.children",
                    "message": f"children must be an array (got {type(children).__name__}).",
                    "fix": f"Set {path}.children to [] or an array of task objects.",
                }
            )
            return
        for i, child in enumerate(children or []):
            walk(child, f"{path}.children[{i}]")

    walk(s["root"], "root")
    return errors, warnings


def main() -> int:
    errors: list[str] = []

    def check(fn) -> None:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
        except AssertionError as exc:
            errors.append(str(exc))
            print(f" FAIL {fn.__name__}: {exc}")

    html = HTA_HTML.read_text(encoding="utf-8") if HTA_HTML.is_file() else ""
    js = APP_JS.read_text(encoding="utf-8") if APP_JS.is_file() else ""

    def test_files_exist() -> None:
        assert_true(HTA_HTML.is_file(), "hta-editor2.html missing")
        assert_true(APP_JS.is_file(), "hta-editor-app.js missing")
        assert_true(LEGACY_HTML.is_file(), "legacy hta-editor.html should remain")
        assert_true(SAMPLE.is_file(), "fixtures/hta-sample.json missing")
        assert_true(BROKEN.is_file(), "fixtures/hta-broken.json missing")

    def test_html_loads_app_script() -> None:
        assert_contains("hta-editor2.html", html, '<script src="scripts/hta-editor-app.js"></script>')
        assert_not_contains("hta-editor2.html", html, "let hierarchyData")
        assert_not_contains("hta-editor2.html", html, "function parseHierarchy")

    def test_seed_textarea_present() -> None:
        assert_contains("hta-editor2.html", html, 'id="textInput"')
        assert_contains("hta-editor2.html", html, "Read File")
        assert_contains("hta-editor2.html", html, "Read Header")
        assert_contains("hta-editor2.html", html, 'data-action="exportState"')
        assert_contains("hta-editor2.html", html, 'data-action="importState"')
        assert_contains("hta-editor2.html", html, 'id="import-state-file"')

    def test_state_api_present() -> None:
        for name in (
            "function hydrateFromDom",
            "function commit(",
            "function render(",
            "function parseHierarchy",
            "function treeToIndentedText",
            "function validateImportState",
            "function normalizeImportedState",
            "function serializeState",
            "function applyState",
            "function loadState",
            "function buildConnectors",
            "function setTheme",
            "window.HTAEditor",
        ):
            assert_contains("hta-editor-app.js", js, name)

    def test_no_legacy_dual_store() -> None:
        assert_not_contains("hta-editor-app.js", js, "let hierarchyData =")

    def test_parse_serialize_round_trip() -> None:
        seed = "Read File\n\tRead Header\n\t\tRead File Version\n\t\tRead Meta Data\n\tRead Body"
        root = parse_hierarchy(seed)
        assert_true(root is not None, "parse failed")
        assert_true(count_tasks(root) == 5, f"expected 5 tasks, got {count_tasks(root)}")
        text = tree_to_indented_text(root)
        again = parse_hierarchy(text)
        assert_true(again is not None, "re-parse failed")
        assert_true(count_tasks(again) == 5, "round-trip task count mismatch")
        assert_true(again["title"] == "Read File", "root title mismatch")
        assert_true(len(again["children"]) == 2, "root children mismatch")

    def test_import_validation_blocks_broken() -> None:
        raw = json.loads(BROKEN.read_text(encoding="utf-8"))
        errs, _warns = validate_import_state(raw)
        assert_true(len(errs) >= 1, "expected errors for broken fixture")
        assert_true(
            any("children" in e["path"] for e in errs),
            f"expected children path error, got {errs}",
        )

    def test_import_validation_accepts_sample() -> None:
        raw = json.loads(SAMPLE.read_text(encoding="utf-8"))
        errs, _warns = validate_import_state(raw)
        assert_true(len(errs) == 0, f"sample should pass, got {errs}")
        assert_true(count_tasks(raw["root"]) == 5, "sample should have 5 tasks")

    def test_css_theme_tokens() -> None:
        assert_contains("hta-editor2.html", html, "--color-background-base")
        assert_contains("hta-editor2.html", html, 'body[data-theme="dark"]')
        assert_contains("hta-editor2.html", html, "Source Sans 3")
        assert_contains("hta-editor2.html", html, ".desc-text")
        assert_contains("hta-editor2.html", html, ".task.is-keyboard-hover")

    def test_description_edit_session() -> None:
        for name in (
            "function startEditSession",
            "function applyEditSession",
            "function cancelEditSession",
            "function handleEditBlur",
            "function beginFieldEdit",
            "function setKeyboardNavTarget",
            "function navigateTasks",
            "function navigateSiblingHover",
            "function moveSelectedAmongSiblings",
            "function handleHorizontalArrow",
            "function handleEnterOnComponent",
            "function getSiblingContext",
            "function findParentOf",
            'dataset.role = "description"',
            'className = "desc-text"',
            'contentEditable = "true"',
            "setKeyboardNavTarget(el, { select: false })",
            'beginFieldEdit(current, "description")',
        ):
            assert_contains("hta-editor-app.js", js, name)
        assert_not_contains("hta-editor-app.js", js, 'className = "task-title"')
        assert_not_contains("hta-editor-app.js", js, 'dataset.role = "title"')
        assert_true(
            "taskId.contentEditable" not in js,
            "task ID must not be contenteditable",
        )
        assert_contains("hta-editor-app.js", js, 'dataset.role = "id"')

    print("hta-editor2 smoke tests")
    for fn in (
        test_files_exist,
        test_html_loads_app_script,
        test_seed_textarea_present,
        test_state_api_present,
        test_no_legacy_dual_store,
        test_parse_serialize_round_trip,
        test_import_validation_blocks_broken,
        test_import_validation_accepts_sample,
        test_css_theme_tokens,
        test_description_edit_session,
    ):
        check(fn)

    if errors:
        print(f"\n{len(errors)} failed")
        return 1
    print("\nAll smoke tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
