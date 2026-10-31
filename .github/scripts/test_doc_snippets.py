"""Tests for doc-snippets.py. Run: python -m pytest .github/scripts/test_doc_snippets.py

No network: the package build step is replaced by a stub that only lays out the directories the
runner expects. Blocks themselves run for real (python, bash, and node when it is installed).
The CLI tests copy the script into a fixture repository, so ROOT points at the fixture.
"""
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent / "doc-snippets.py"
F3 = "`" * 3
NODE = shutil.which("node")
needs_node = pytest.mark.skipif(NODE is None, reason="node is not installed")


def _load():
    spec = importlib.util.spec_from_file_location("doc_snippets", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


DS = _load()


def fake_build(work):
    """Stands in for build(): the same layout without npm or pip (and without the network)."""
    project = work / "project"
    (project / "node_modules" / ".bin").mkdir(parents=True)
    venv_bin = work / "venv" / "bin"
    venv_bin.mkdir(parents=True)
    # realpath: a symlink to a venv's python would not find its standard library.
    (venv_bin / "python").symlink_to(os.path.realpath(sys.executable))
    return project, work / "venv"


def line_of(text, needle):
    for n, line in enumerate(text.split("\n"), start=1):
        if line.strip() == needle.strip():
            return n
    raise AssertionError(f"{needle!r} not found")


def make_repo(tmp_path, files):
    root = tmp_path / "repo"
    (root / ".github" / "scripts").mkdir(parents=True)
    shutil.copy(SCRIPT, root / ".github" / "scripts" / "doc-snippets.py")
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def run_cli(root, *args):
    return subprocess.run(
        [sys.executable, "-I", str(root / ".github" / "scripts" / "doc-snippets.py"), *args],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )


def run_in_process(monkeypatch, capsys, root, netns=False):
    monkeypatch.setattr(DS, "ROOT", root)
    monkeypatch.setattr(DS, "build", fake_build)
    rc = DS.cmd_run(netns)
    return rc, capsys.readouterr().out


def marked(lang, code):
    return f"<!-- snippet-test -->\n\n{F3}{lang}\n{code}\n{F3}\n"


# ---------- parse(): fences, languages, indentation ----------

def test_fence_language_is_lowercased_and_marker_applies(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    doc = tmp_path / "README.md"
    doc.write_text(marked("Python", "print(1)"), encoding="utf-8")
    blocks, errors = DS.parse(doc)
    assert errors == []
    assert len(blocks) == 1
    assert blocks[0]["lang"] == "python"
    assert blocks[0]["marked"] is True
    assert blocks[0]["code"] == "print(1)\n"
    assert DS.skip_reason(blocks[0]) is None


def test_tilde_fence_is_closed_only_by_a_tilde_fence(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    doc = tmp_path / "README.md"
    doc.write_text("~~~python\nprint(1)\n" + F3 + "\nprint(2)\n~~~\n", encoding="utf-8")
    blocks, errors = DS.parse(doc)
    assert errors == []
    assert len(blocks) == 1
    assert blocks[0]["code"] == "print(1)\n" + F3 + "\nprint(2)\n"


def test_longer_fence_can_contain_a_shorter_one(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    doc = tmp_path / "README.md"
    doc.write_text("````md\n" + F3 + "python\nx = 1\n" + F3 + "\n````\n\n" + F3 + "sh\necho a\n" + F3 + "\n",
                   encoding="utf-8")
    blocks, errors = DS.parse(doc)
    assert errors == []
    assert [b["lang"] for b in blocks] == ["md", "sh"]
    assert blocks[0]["code"] == F3 + "python\nx = 1\n" + F3 + "\n"
    assert blocks[1]["code"] == "echo a\n"


def test_indented_fence_loses_its_indent(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    doc = tmp_path / "docs" / "guide.md"
    doc.parent.mkdir()
    doc.write_text("1. step\n\n   " + F3 + "js\n   a();\n   b();\n   " + F3 + "\n", encoding="utf-8")
    blocks, _ = DS.parse(doc)
    assert blocks[0]["code"] == "a();\nb();\n"
    assert blocks[0]["line"] == 3


def test_skip_reasons(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    doc = tmp_path / "README.md"
    doc.write_text(
        marked("py", "print(1)")
        + "\n" + F3 + "\nplain\n" + F3 + "\n"
        + "\n" + F3 + "ts\nconst a: number = 1;\n" + F3 + "\n",
        encoding="utf-8",
    )
    blocks, errors = DS.parse(doc)
    reasons = [DS.skip_reason(b) for b in blocks]
    assert reasons == [None, "not a runnable language (no language)", "not a runnable language (ts)"]
    assert errors == []


# ---------- parse(): skip markers ----------

def test_marker_may_be_followed_by_blank_lines(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    doc = tmp_path / "README.md"
    doc.write_text("<!--snippet-test-->\n\n\n" + F3 + "bash\necho ok\n" + F3 + "\n", encoding="utf-8")
    blocks, errors = DS.parse(doc)
    assert errors == []
    assert blocks[0]["marked"] is True


def test_marker_applies_only_to_the_next_block(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    doc = tmp_path / "README.md"
    doc.write_text(marked("bash", "echo one") + "\n" + F3 + "bash\necho two\n" + F3 + "\n", encoding="utf-8")
    blocks, errors = DS.parse(doc)
    assert errors == []
    assert [b["marked"] for b in blocks] == [True, False]


def test_marker_errors_name_file_and_line(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    cases = {
        "text_after_marker": ("<!-- snippet-test -->\nSome prose.\n\n" + F3 + "py\nx\n" + F3 + "\n", 1),
        "marker_at_end_of_file": ("intro\n\n<!-- snippet-test -->\n", 3),
        "marker_on_ts_block": ("<!-- snippet-test -->\n" + F3 + "ts\nx\n" + F3 + "\n", 1),
        "two_markers_in_a_row": ("<!-- snippet-test -->\n<!-- snippet-test -->\n" + F3 + "py\nx\n" + F3 + "\n", 1),
    }
    for name, (text, line) in cases.items():
        doc = tmp_path / f"{name}.md"
        doc.write_text(text, encoding="utf-8")
        _, errors = DS.parse(doc)
        assert len(errors) == 1, name
        assert errors[0].startswith(f"{name}.md:{line}: "), (name, errors)


def test_marker_on_unsupported_language_reports_the_language(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    doc = tmp_path / "README.md"
    doc.write_text("<!-- snippet-test -->\n" + F3 + "ts\nx\n" + F3 + "\n", encoding="utf-8")
    _, errors = DS.parse(doc)
    assert errors == ["README.md:1: snippet-test marker on a 'ts' block; only javascript, python and bash can run"]


def test_doc_files_scope(tmp_path, monkeypatch):
    monkeypatch.setattr(DS, "ROOT", tmp_path)
    wanted = ["README.md", "packages/a/README.md", "docs/x.md"]
    unwanted = ["CHANGELOG.md", "packages/README.md", "packages/a/src/README.md", "docs/nested/y.md"]
    for rel in wanted + unwanted:
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text("x\n", encoding="utf-8")
    got = sorted(p.relative_to(tmp_path).as_posix() for p in DS.doc_files())
    assert got == sorted(wanted)


# ---------- list command (real CLI on a fixture repository) ----------

def test_list_reports_each_block_and_why_it_is_skipped(tmp_path):
    readme = (
        "# Demo\n\n" + marked("py", "print('hi')")
        + "\n" + F3 + "js\nconsole.log(1)\n" + F3
        + "\n\n" + F3 + "text\nnot code\n" + F3 + "\n"
    )
    root = make_repo(tmp_path, {"README.md": readme})
    result = run_cli(root, "list")
    assert result.returncode == 0, result.stdout + result.stderr
    py_line = line_of(readme, "<!-- snippet-test -->") + 2
    assert "3 blocks, 1 marked to run" in result.stdout
    assert f"  README.md:{py_line} py: RUN" in result.stdout
    assert "js: skip - not marked" in result.stdout
    assert "text: skip - not a runnable language (text)" in result.stdout


def test_list_fails_with_file_and_line_on_a_marker_error(tmp_path):
    readme = "intro\n\n<!-- snippet-test -->\nSome prose here.\n"
    root = make_repo(tmp_path, {"README.md": readme})
    result = run_cli(root, "list")
    assert result.returncode == 1
    assert "::error::README.md:3: snippet-test marker is not followed by a code block" in result.stdout


def test_run_stops_before_building_when_a_marker_is_broken(tmp_path):
    root = make_repo(tmp_path, {"README.md": "<!-- snippet-test -->\nprose\n"})
    result = run_cli(root, "run")
    assert result.returncode == 1
    assert "::error::README.md:1:" in result.stdout
    assert "Build the packages" not in result.stdout


def test_no_command_prints_usage_and_exits_2(tmp_path):
    root = make_repo(tmp_path, {})
    result = run_cli(root)
    assert result.returncode == 2
    assert "doc-snippets.py list" in result.stdout


# ---------- run command (in process, build stubbed) ----------

def test_passing_blocks_exit_zero(tmp_path, monkeypatch, capsys):
    readme = "# Demo\n\n" + marked("py", "print('py ok')") + "\n" + marked("sh", "echo sh ok")
    if NODE:
        readme += "\n" + marked("js", "console.log('js ok')")
    root = make_repo(tmp_path, {"README.md": readme})
    rc, out = run_in_process(monkeypatch, capsys, root)
    expected = 3 if NODE else 2
    assert rc == 0, out
    assert f"Executed {expected} block(s), 0 failed, skipped 0" in out
    assert "FAILED" not in out


def test_failing_python_block_reports_file_and_line(tmp_path, monkeypatch, capsys):
    readme = "# Demo\n\n" + marked("py", "print('fine')") + "\nprose\n\n" + marked("python", "raise SystemExit(3)")
    root = make_repo(tmp_path, {"README.md": readme})
    rc, out = run_in_process(monkeypatch, capsys, root)
    fail_line = readme.split("\n").index(F3 + "python") + 1  # the fence line
    assert rc == 1
    assert f"::error file=README.md,line={fail_line}::this documented snippet failed (exit 3)" in out
    assert f"FAILED: README.md:{fail_line}" in out
    assert f"README.md:{fail_line} python: FAIL (exit 3)" in out


def test_failure_in_a_docs_file_names_that_file(tmp_path, monkeypatch, capsys):
    guide = "# Guide\n\n" + marked("bash", "false")
    root = make_repo(tmp_path, {"README.md": "# Demo\n", "docs/guide.md": guide})
    rc, out = run_in_process(monkeypatch, capsys, root)
    assert rc == 1
    assert "::error file=docs/guide.md,line=" in out
    assert "FAILED: docs/guide.md:" in out


def test_shell_block_fails_on_a_broken_pipe_stage(tmp_path, monkeypatch, capsys):
    # bash runs with -e -o pipefail: a failing stage in the middle of a pipeline fails the block.
    root = make_repo(tmp_path, {"README.md": marked("sh", "false | true")})
    rc, out = run_in_process(monkeypatch, capsys, root)
    assert rc == 1
    assert "FAIL (exit 1)" in out


def test_block_that_hangs_is_a_failure(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(DS, "RUN_TIMEOUT", 1)
    root = make_repo(tmp_path, {"README.md": marked("py", "import time\ntime.sleep(30)")})
    rc, out = run_in_process(monkeypatch, capsys, root)
    assert rc == 1
    assert "FAIL (exit 124)" in out
    assert "timed out after 1 s" in out


def test_block_cannot_see_credentials_from_the_runner(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("ZN_TEST_SECRET_KEY", "not-real")
    code = (
        "import os\n"
        "assert 'ANTHROPIC_API_KEY' not in os.environ\n"
        "assert 'ZN_TEST_SECRET_KEY' not in os.environ\n"
        "print('clean')\n"
    )
    root = make_repo(tmp_path, {"README.md": marked("py", code)})
    rc, out = run_in_process(monkeypatch, capsys, root)
    assert rc == 0, out


def test_blocks_do_not_share_state(tmp_path, monkeypatch, capsys):
    first = marked("py", "open('state.txt', 'w').write('x')")
    second = marked("py", "import os\nassert not os.path.exists('state.txt')")
    root = make_repo(tmp_path, {"README.md": first + "\n" + second})
    rc, out = run_in_process(monkeypatch, capsys, root)
    assert rc == 0, out
    assert "Executed 2 block(s), 0 failed" in out


def test_skipped_blocks_are_listed_by_reason(tmp_path, monkeypatch, capsys):
    readme = marked("py", "print(1)") + "\n" + F3 + "py\nprint(2)\n" + F3 + "\n\n" + F3 + "text\nx\n" + F3 + "\n"
    root = make_repo(tmp_path, {"README.md": readme})
    rc, out = run_in_process(monkeypatch, capsys, root)
    assert rc == 0, out
    assert "Skipped:" in out
    assert "- not marked: 1" in out
    # The marked block above has the same opening line, so take the last match: the unmarked one.
    unmarked_fence_line = max(n for n, line in enumerate(readme.split("\n"), 1) if line == F3 + "py")
    assert f"    README.md:{unmarked_fence_line} (py)" in out
    assert "- not a runnable language (text): 1" in out


def test_summary_is_written_to_the_step_summary_file(tmp_path, monkeypatch, capsys):
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    root = make_repo(tmp_path, {"README.md": marked("py", "print(1)")})
    rc, _ = run_in_process(monkeypatch, capsys, root)
    assert rc == 0
    text = summary.read_text(encoding="utf-8")
    assert text.startswith("### Doc snippets\n\n" + F3 + "\n")
    assert "Executed 1 block(s), 0 failed, skipped 0" in text


@needs_node
def test_javascript_block_runs_inside_the_project(tmp_path, monkeypatch, capsys):
    # Node runs from snippet-N inside the project, so the block sees the project's installs.
    code = "if (!process.cwd().includes('project')) process.exit(4);\nconsole.log('js');\n"
    root = make_repo(tmp_path, {"README.md": marked("javascript", code)})
    rc, out = run_in_process(monkeypatch, capsys, root)
    assert rc == 0, out
