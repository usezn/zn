"""Tests for check-license-allowlist.py: the license lists must not drift apart.
Run: python3 -m pytest -q .github/scripts/test_check_license_allowlist.py
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "check-license-allowlist.py"
REPO = HERE.parents[1]

ALLOW = "# comment\nMIT\nZlib\n"
DENY = '[licenses]\nconfidence-threshold = 0.9\nallow = [\n    "MIT", # inline\n    "Zlib",\n]\n\n[bans]\nallow = ["x"]\n'
WORKFLOW = "      - uses: x\n        with:\n          allow-licenses: MIT, Zlib\n"


def run(tmp_path, allow=ALLOW, deny=DENY, workflow=WORKFLOW):
    files = []
    for name, text in (("a.txt", allow), ("deny.toml", deny), ("w.yml", workflow)):
        p = tmp_path / name
        p.write_text(text, encoding="utf-8")
        files.append(str(p))
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *files], capture_output=True, text=True, check=False)


def test_matching_lists_pass(tmp_path):
    r = run(tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr


def test_with_exception_on_an_allowed_base_passes(tmp_path):
    r = run(tmp_path, deny=DENY.replace('"Zlib",', '"Zlib",\n    "MIT WITH LLVM-exception",'))
    assert r.returncode == 0, r.stdout


def test_with_exception_on_a_base_outside_the_list_fails(tmp_path):
    r = run(tmp_path, deny=DENY.replace('"Zlib",', '"Zlib",\n    "GPL-3.0 WITH LLVM-exception",'))
    assert r.returncode == 1
    assert "base license" in r.stdout


def test_unknown_exception_fails(tmp_path):
    r = run(tmp_path, deny=DENY.replace('"Zlib",', '"Zlib",\n    "MIT WITH Other-exception",'))
    assert r.returncode == 1
    assert "exception" in r.stdout


def test_id_missing_from_the_workflow_fails(tmp_path):
    r = run(tmp_path, workflow=WORKFLOW.replace(", Zlib", ""))
    assert r.returncode == 1
    assert "dependency-review.yml allow-licenses lacks Zlib" in r.stdout


def test_extra_id_in_deny_toml_fails(tmp_path):
    r = run(tmp_path, deny=DENY.replace('"Zlib",', '"Zlib",\n    "MPL-2.0",'))
    assert r.returncode == 1
    assert "deny.toml has MPL-2.0" in r.stdout


def test_unreadable_input_fails_closed(tmp_path):
    r = run(tmp_path, workflow="name: nothing here\n")
    assert r.returncode == 2


def test_the_repository_lists_agree_today():
    r = subprocess.run([sys.executable, "-I", str(SCRIPT)], capture_output=True, text=True, check=False, cwd=REPO)
    assert r.returncode == 0, r.stdout + r.stderr
