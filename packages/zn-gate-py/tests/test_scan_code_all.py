"""`zn-gate scan --code` and `--all` (same file selection as the npm package).

A normal scan reads prompts, docs and configs. `--code` (or `--all`, the same
option) adds source files: .js .ts .py .sh .html .go .rs. A file named on the
command line is read whatever its extension.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from zn_gate import cli

BASE = ["a.md", "b.txt", "c.prompt", "d.json", "e.yaml", "f.yml", "g.toml", "h.env", "i.pem", "j.key"]
CODE = ["k.js", "l.ts", "m.py", "n.sh", "o.html", "p.go", "q.rs"]
OTHER = ["r.c", "s.java", "t.rb"]


def _tree(root: Path) -> Path:
    for name in BASE + CODE + OTHER:
        (root / name).write_text("hello there, nothing to see\n")
    return root


def _run(capsys, *argv):
    parser = cli.build_parser() if hasattr(cli, "build_parser") else None
    assert parser is not None
    args = parser.parse_args(["scan", *argv])
    code = cli.cmd_scan(args)
    return code, capsys.readouterr().out


def _scanned(capsys, tree, *flags):
    code, out = _run(capsys, str(tree), "--format", "json", *flags)
    return code, json.loads(out)["total_files"]


def test_default_scan_skips_source_files(tmp_path, capsys):
    code, n = _scanned(capsys, _tree(tmp_path))
    assert (code, n) == (0, len(BASE))


@pytest.mark.parametrize("flag", ["--code", "--all"])
def test_code_and_all_add_source_files(tmp_path, capsys, flag):
    code, n = _scanned(capsys, _tree(tmp_path), flag)
    assert (code, n) == (0, len(BASE) + len(CODE))


def test_code_finds_secret_in_source_file(tmp_path, capsys):
    (tmp_path / "app.py").write_text('KEY = "AKIAIOSFODNN7EXAMPLE"\n')
    code, out = _run(capsys, str(tmp_path), "--format", "json")
    assert code == 3 and json.loads(out)["total_files"] == 0
    code, out = _run(capsys, str(tmp_path), "--format", "json", "--code")
    assert code == 1 and json.loads(out)["total_secrets"] == 1


def test_code_with_allow_partial_still_accepts_skipped(tmp_path, capsys):
    _tree(tmp_path)
    (tmp_path / "big.py").write_bytes(b"x" * cli._MAX_SCAN_BYTES)
    code, out = _run(capsys, str(tmp_path), "--format", "json", "--code")
    assert code == 3 and json.loads(out)["total_skipped"] == 1
    code, out = _run(capsys, str(tmp_path), "--format", "json", "--code", "--allow-partial")
    assert code == 0 and json.loads(out)["incomplete"] is True


def test_named_file_is_read_without_code(tmp_path, capsys):
    f = tmp_path / "x.py"
    f.write_text("print(1)\n")
    code, out = _run(capsys, str(f), "--format", "json")
    assert (code, json.loads(out)["total_files"]) == (0, 1)


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("flags", [[], ["--code"], ["--all"]])
def test_same_file_count_as_npm(tmp_path, capsys, flags):
    cli_js = Path(__file__).resolve().parents[2] / "zn-gate" / "bin" / "cli.js"
    if not cli_js.exists():
        pytest.skip("npm package not in this checkout")
    tree = _tree(tmp_path)
    out = subprocess.run(["node", str(cli_js), "scan", str(tree), "--format", "json", *flags],
                         capture_output=True, text=True, timeout=60).stdout
    _, n = _scanned(capsys, tree, *flags)
    assert json.loads(out)["total_files"] == n
