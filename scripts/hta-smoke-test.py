#!/usr/bin/env python3
"""Static smoke tests for HTA.html + TTA (scripts/hta-app.js)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTA_HTML = ROOT / "HTA.html"
APP_JS = ROOT / "scripts" / "hta-app.js"
SAMPLE = ROOT / "fixtures" / "hta-tta-sample.json"
EDITOR2 = ROOT / "hta-editor2.html"


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def assert_contains(label: str, haystack: str, needle: str) -> None:
    assert_true(needle in haystack, f"{label}: expected to contain {needle!r}")


def assert_not_contains(label: str, haystack: str, needle: str) -> None:
    assert_true(needle not in haystack, f"{label}: expected NOT to contain {needle!r}")


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
        assert_true(HTA_HTML.is_file(), "HTA.html missing")
        assert_true(APP_JS.is_file(), "hta-app.js missing")
        assert_true(SAMPLE.is_file(), "fixtures/hta-tta-sample.json missing")
        assert_true(EDITOR2.is_file(), "hta-editor2.html should remain")

    def test_html_shell() -> None:
        assert_contains("HTA.html", html, 'src="scripts/hta-app.js"')
        assert_contains("HTA.html", html, 'id="ttaTable"')
        assert_contains("HTA.html", html, 'id="columnPicker"')
        assert_contains("HTA.html", html, 'id="htaViewport"')
        assert_contains("HTA.html", html, 'id="splitResizer"')
        assert_contains("HTA.html", html, 'class="hta-header"')
        assert_contains("HTA.html", html, "<h2>HTA</h2>")
        assert_contains("HTA.html", html, "<h2>TTA</h2>")
        assert_contains("HTA.html", html, 'data-action="addChild"')
        assert_contains("HTA.html", html, 'data-action="addSibling"')
        assert_contains("HTA.html", html, 'data-action="duplicateTask"')
        assert_contains("HTA.html", html, 'data-action="toggleColumnPicker"')
        assert_contains("HTA.html", html, 'data-action="exportTtaCsv"')
        assert_contains("HTA.html", html, "Export CSV")
        assert_not_contains("HTA.html", html, 'id="textInput"')
        assert_not_contains("HTA.html", html, "Delete task")

    def test_app_apis() -> None:
        for name in (
            "function renderTta",
            "function orderedTtaRows",
            "function addChildTask",
            "function addSiblingTask",
            "function duplicateTask",
            "function deleteSelectedTask",
            "function reassignIdsAndRemapTta",
            "function highlightTtaForTask",
            "function moveSelectedAmongSiblings",
            "function outdentSelected",
            "function indentSelected",
            "function handleSelectedArrow",
            "function ensureTtaCoversAllTasks",
            "function emptyTtaRecord",
            "function toggleColumnPicker",
            "function buildTtaCsv",
            "function exportTtaCsv",
            "function loadSplitPct",
            "function setSpacePanArmed",
            "function undoState",
            "function redoState",
            "function recordStateHistory",
            'DIAGRAM_VERSION = 2',
            'a.download = "hta-tta.json"',
            'a.download = "hta-tta.csv"',
            "window.HTAEditor",
        ):
            assert_contains("hta-app.js", js, name)
        assert_contains("HTA.html", html, 'data-shortcut="c"')
        assert_contains("HTA.html", html, 'data-shortcut="s"')
        assert_contains("HTA.html", html, 'data-shortcut="d"')
        assert_not_contains("HTA.html", html, 'data-shortcut="l"')
        assert_contains("hta-app.js", js, "Outline")
        assert_contains("hta-app.js", js, '\\uFEFF')

    def test_sample_fixture() -> None:
        raw = json.loads(SAMPLE.read_text(encoding="utf-8"))
        assert_true(raw.get("version") == 2, "sample version should be 2")
        assert_true(isinstance(raw.get("ttaRecords"), list), "ttaRecords required")
        assert_true(len(raw["ttaRecords"]) >= 3, "expected demo TTA rows")
        task_ids = {r["taskId"] for r in raw["ttaRecords"]}
        assert_true("1.1" in task_ids and "1.2" in task_ids, "expected 1.1 and 1.2 rows")
        assert_true(
            sum(1 for r in raw["ttaRecords"] if r["taskId"] == "1.1") >= 2,
            "one-to-many demo for 1.1",
        )

    print("HTA.html + TTA smoke tests")
    for fn in (
        test_files_exist,
        test_html_shell,
        test_app_apis,
        test_sample_fixture,
    ):
        check(fn)

    if errors:
        print(f"\n{len(errors)} failed")
        return 1
    print("\nAll smoke tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
