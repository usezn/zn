"""Premise checks for two CLI shapes of the Python zn-gate command.

- `analyze` has no --file option: argparse rejects it with exit 2 and "unrecognized arguments: --file". The one-line
  error of the premise is not what argparse prints (it prints the usage block first), so that part is strict xfail.
- `scan --format sarif` is not a format: the choices are text, json and github, so argparse exits 2. The SARIF
  ruleId and region check is strict xfail, because the Python scan has no SARIF writer.
"""

import os
import subprocess
import sys

import pytest

_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")


def _zn(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONPATH"] = _SRC + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        [sys.executable, "-m", "zn_gate", *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=120,
    )


def test_analyze_file_option_is_unrecognized() -> None:
    proc = _zn("analyze", "--file", "/nonexistent/sample.txt")
    assert proc.returncode == 2
    assert "unrecognized arguments: --file" in proc.stderr


@pytest.mark.xfail(
    strict=True,
    reason="premise partly false: argparse prints a usage block before the error, so stderr is not one line",
)
def test_analyze_file_error_is_one_line() -> None:
    proc = _zn("analyze", "--file", "/nonexistent/sample.txt")
    assert len(proc.stderr.strip().splitlines()) == 1


def test_scan_rejects_sarif_format() -> None:
    proc = _zn("scan", "--format", "sarif", "/nonexistent/sample")
    assert proc.returncode == 2
    assert "invalid choice: 'sarif'" in proc.stderr


@pytest.mark.xfail(
    strict=True,
    reason="premise false: the Python scan has no SARIF output (--format is text, json or github)",
)
def test_scan_sarif_results_have_rule_id_and_region() -> None:
    proc = _zn("scan", "--format", "sarif", "/nonexistent/sample")
    assert proc.returncode == 0
    assert '"ruleId"' in proc.stdout and '"region"' in proc.stdout
