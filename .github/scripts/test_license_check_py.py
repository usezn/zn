"""Tests for license-check-py.py: the PyPI license report against the allowlist.

The script is informational, so it exits 0 whenever it can read its inputs. Each test runs
the real script (as CI does, with -I) on a pip-licenses JSON file written to a temp dir.
Run: python3 -m pytest -q .github/scripts/test_license_check_py.py
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "license-check-py.py"
ALLOWLIST_TEXT = "# SPDX ids accepted for shipped dependencies\nMIT\nBSD-3-Clause\nBSD-2-Clause\nApache-2.0\nISC\n"


def row(name, version, license_name):
    return {"Name": name, "Version": version, "License": license_name}


def run(tmp_path, rows, allow=ALLOWLIST_TEXT, summary=None):
    licenses = tmp_path / "licenses.json"
    licenses.write_text(json.dumps(rows), encoding="utf-8")
    allow_file = tmp_path / "allowlist.txt"
    allow_file.write_text(allow, encoding="utf-8")
    env = {k: v for k, v in os.environ.items() if k != "GITHUB_STEP_SUMMARY"}
    if summary is not None:
        env["GITHUB_STEP_SUMMARY"] = str(summary)
    return subprocess.run(
        [sys.executable, "-I", str(SCRIPT), str(licenses), str(allow_file)],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )


def table_row(name, version, license_name, status):
    return f"| {name} | {version} | {license_name} | {status} |"


def header(total, outside):
    return f"### PyPI package and dependencies: {total} package(s), {outside} outside the allowlist"


def warning(name, version, license_name):
    return f"::warning title=License outside the allowlist::{name}=={version} is {license_name}"


def test_allowed_license_is_ok_with_no_warning_and_exit_zero(tmp_path):
    r = run(tmp_path, [row("alpha", "1.0.0", "MIT")])
    assert r.returncode == 0, r.stderr
    assert header(1, 0) in r.stdout
    assert table_row("alpha", "1.0.0", "MIT", "ok") in r.stdout
    assert "::warning" not in r.stdout


def test_denied_license_is_flagged_for_review_and_still_exits_zero(tmp_path):
    r = run(tmp_path, [row("copyleft", "3.1.4", "GPL-3.0"), row("fine", "1.0.0", "MIT")])
    assert r.returncode == 0, "the report is informational and must not fail the job"
    assert header(2, 1) in r.stdout
    assert table_row("copyleft", "3.1.4", "GPL-3.0", "review") in r.stdout
    assert table_row("fine", "1.0.0", "MIT", "ok") in r.stdout
    assert warning("copyleft", "3.1.4", "GPL-3.0") in r.stdout
    assert warning("fine", "1.0.0", "MIT") not in r.stdout


def test_unknown_license_is_flagged(tmp_path):
    r = run(tmp_path, [row("mystery", "0.1.0", "UNKNOWN")])
    assert r.returncode == 0
    assert table_row("mystery", "0.1.0", "UNKNOWN", "review") in r.stdout
    assert warning("mystery", "0.1.0", "UNKNOWN") in r.stdout


@pytest.mark.parametrize(
    "classifier, spdx",
    [
        ("MIT License", "MIT"),
        ("BSD License", "BSD-3-Clause"),
        ("Apache Software License", "Apache-2.0"),
        pytest.param(
            "ISC License (ISCL)",
            "ISC",
            marks=pytest.mark.xfail(
                strict=True,
                reason="known bug: is_allowed() strips the trailing ')' before the NAMES lookup, "
                "so 'ISC License (ISCL)' is never mapped to ISC and ISC packages are flagged",
            ),
        ),
    ],
)
def test_classifier_names_are_mapped_to_spdx_ids(tmp_path, classifier, spdx):
    r = run(tmp_path, [row("pkg", "1.0.0", classifier)])
    assert table_row("pkg", "1.0.0", classifier, "ok") in r.stdout, f"{classifier} should map to {spdx}"
    assert "::warning" not in r.stdout


def test_dual_license_or_needs_one_allowed_alternative(tmp_path):
    r = run(
        tmp_path,
        [
            row("or-allowed", "1.0.0", "(MIT OR GPL-3.0)"),
            row("or-denied", "1.0.0", "(GPL-3.0 OR AGPL-3.0)"),
            row("semicolon", "1.0.0", "MIT; GPL-3.0"),
        ],
    )
    assert table_row("or-allowed", "1.0.0", "(MIT OR GPL-3.0)", "ok") in r.stdout
    assert table_row("or-denied", "1.0.0", "(GPL-3.0 OR AGPL-3.0)", "review") in r.stdout
    # pip-licenses separates several licenses with ";"; the script reads it as an alternative.
    assert table_row("semicolon", "1.0.0", "MIT; GPL-3.0", "ok") in r.stdout


def test_and_expression_with_a_denied_part_is_flagged(tmp_path):
    r = run(tmp_path, [row("and-denied", "1.0.0", "MIT AND GPL-3.0")])
    assert table_row("and-denied", "1.0.0", "MIT AND GPL-3.0", "review") in r.stdout


@pytest.mark.xfail(
    strict=True,
    reason="known gap: AND expressions are not split, so both-allowed parts are flagged (conservative)",
)
def test_and_expression_of_allowed_parts_is_ok(tmp_path):
    r = run(tmp_path, [row("and-allowed", "1.0.0", "MIT AND Apache-2.0")])
    assert table_row("and-allowed", "1.0.0", "MIT AND Apache-2.0", "ok") in r.stdout


def test_comments_in_the_allowlist_are_not_license_ids(tmp_path):
    r = run(
        tmp_path,
        [row("commented", "1.0.0", "GPL-3.0"), row("fine", "1.0.0", "MIT")],
        allow="# GPL-3.0 is not accepted\n   # AGPL-3.0\n\nMIT\n",
    )
    assert table_row("commented", "1.0.0", "GPL-3.0", "review") in r.stdout
    assert table_row("fine", "1.0.0", "MIT", "ok") in r.stdout


def test_empty_list_reports_zero_packages(tmp_path):
    r = run(tmp_path, [])
    assert r.returncode == 0, r.stderr
    assert header(0, 0) in r.stdout


def test_step_summary_file_gets_the_same_table(tmp_path):
    summary = tmp_path / "summary.md"
    summary.write_text("", encoding="utf-8")
    r = run(tmp_path, [row("copyleft", "1.0.0", "GPL-3.0")], summary=summary)
    assert r.returncode == 0
    text = summary.read_text(encoding="utf-8")
    assert header(1, 1) in text
    assert table_row("copyleft", "1.0.0", "GPL-3.0", "review") in text
    assert "::warning" not in text, "workflow commands belong to the log, not the summary"


def test_missing_input_file_fails_closed(tmp_path):
    allow_file = tmp_path / "allowlist.txt"
    allow_file.write_text(ALLOWLIST_TEXT, encoding="utf-8")
    r = subprocess.run(
        [sys.executable, "-I", str(SCRIPT), str(tmp_path / "absent.json"), str(allow_file)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert r.returncode != 0
    assert "absent.json" in r.stderr
