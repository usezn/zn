"""zn-gate reach --history in the Python package: same behaviour and same --json as the npm package.

All values below are obviously fake and are put together at run time.
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

from zn_gate import cli, reach_history
from zn_gate.reach_history import history, report

_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src")
_NODE_CLI = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "zn-gate", "bin", "cli.js"))

# The AWS documentation example key, and fake keys that only have the shape of the real ones.
AWS = "AKIA" + "IOSFODNN7EXAMPLE"
GITHUB = "gh" + "p_" + "FAKE0123456789abcdefFAKE0123456789ab"
ANTHROPIC = "sk-" + "ant-api03-" + "FAKE0123456789abcdefFAKE0123456789abcdef-FAKE"
GITLAB = "glpat" + "-" + "FAKE0123456789abcdefXY"
FAKES = [AWS, GITHUB, ANTHROPIC, GITLAB]


def jsonl(lines):
    return "".join(json.dumps(x) + "\n" for x in lines)


def put(home, rel, text, mtime=None):
    path = os.path.join(str(home), *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def claude_fixture(home):
    put(home, ".claude/projects/-proj-a/sess1.jsonl", jsonl([
        {"type": "user", "message": {"role": "user", "content": "deploy with " + AWS + " please"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "ok, key " + AWS + " and token " + GITHUB}]}},
        {"type": "user", "message": {"content": "nothing here"}},
    ]), 1_700_000_300)
    put(home, ".claude/projects/-proj-a/sess2.jsonl", jsonl([{"type": "user", "message": {"content": "clean session"}}]), 1_700_000_200)
    put(home, ".claude/history.jsonl", jsonl([{"display": "my gitlab token " + GITLAB}]), 1_700_000_100)
    put(home, ".codex/sessions/2026/10/30/rollout-2026-10-30T10-00-00-abc.jsonl", jsonl([
        {"type": "response_item", "payload": {"type": "message", "content": [{"type": "input_text", "text": "my key is " + ANTHROPIC}]}},
    ]), 1_700_000_400)


def no_secret(output):
    for v in FAKES:
        assert v not in output, "a whole value is in the output"
        for i in range(0, len(v) - 7):
            assert v[i:i + 8] not in output, "a fragment of a value is in the output"


@pytest.fixture
def machine(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    env = {"HOME": str(home), "USERPROFILE": str(home), "PATH": os.environ.get("PATH", ""),
           "ZN_STATS": "off", "PYTHONPATH": _SRC, "PYTHONIOENCODING": "utf-8"}
    return str(home), env


def zn(env, *args):
    return subprocess.run([sys.executable, "-m", "zn_gate.cli", *args], capture_output=True, text=True, env=env, timeout=120)


def test_finds_secrets_and_reports_type_and_count_only(machine):
    home, env = machine
    claude_fixture(home)
    r = history(home=home, env=env)
    assert r["tool"] == "zn-gate reach --history"
    assert r["version"] == 1

    def f(agent, file, type_):
        return next(x for x in r["findings"] if x["agent"] == agent and x["file"] == file and x["type"] == type_)

    assert f("claude-code", "~/.claude/projects/-proj-a/sess1.jsonl", "AWS_KEY")["count"] == 2
    assert f("claude-code", "~/.claude/projects/-proj-a/sess1.jsonl", "GITHUB_TOKEN")["count"] == 1
    assert f("claude-code", "~/.claude/history.jsonl", "GITLAB_TOKEN")["count"] == 1
    assert f("codex", "~/.codex/sessions/2026/10/30/rollout-2026-10-30T10-00-00-abc.jsonl", "ANTHROPIC_KEY")["count"] == 1
    assert not any(x["file"].endswith("sess2.jsonl") for x in r["findings"])
    assert f("claude-code", "~/.claude/projects/-proj-a/sess1.jsonl", "AWS_KEY")["action"].startswith("Rotate this AWS access key ")
    assert r["totals"] == {"files_scanned": 4, "bytes_scanned": r["totals"]["bytes_scanned"], "files_with_secrets": 3,
                           "secrets": 5, "files_not_reached": 0}
    assert r["time_limit_hit"] is False
    assert r["incomplete"] == []
    assert [a["id"] for a in r["agents"]] == ["claude-code", "codex", "cursor", "opencode"]
    assert next(a for a in r["agents"] if a["id"] == "cursor")["reason"] == "database"


def test_no_output_format_holds_a_secret_or_a_part_of_one(machine):
    home, env = machine
    claude_fixture(home)
    r = history(home=home, env=env)
    text = []
    report(r, text.append)
    no_secret("".join(text))
    no_secret(json.dumps(r))
    for args in (["reach", "--history"], ["reach", "--history", "--json"]):
        p = zn(env, *args)
        assert p.returncode == 0, p.stderr
        no_secret(p.stdout + p.stderr)
    assert "AWS_KEY" in zn(env, "reach", "--history").stdout


def test_json_schema_keys_and_order(machine):
    home, env = machine
    claude_fixture(home)
    p = zn(env, "reach", "--history", "--json")
    r = json.loads(p.stdout)
    assert list(r) == ["tool", "version", "agents", "findings", "incomplete", "totals", "time_limit_hit", "max_seconds",
                       "elapsed_ms", "notes"]
    assert list(r["agents"][0]) == ["id", "name", "scanned", "reason", "files", "bytes"]
    assert list(r["findings"][0]) == ["agent", "file", "type", "count", "action"]
    assert list(r["totals"]) == ["files_scanned", "bytes_scanned", "files_with_secrets", "secrets", "files_not_reached"]
    for f in r["findings"]:
        assert isinstance(f["count"], int) and f["count"] > 0


def test_clean_home_reports_nothing_and_writes_nothing(machine):
    home, env = machine
    put(home, ".claude/projects/p/s.jsonl", jsonl([{"type": "user", "message": {"content": "hello"}}]))
    r = history(home=home, env=env)
    assert r["findings"] == []
    text = []
    report(r, text.append)
    assert "No secret found" in "".join(text)
    assert sorted(os.listdir(home)) == [".claude"]


def test_a_zn_marker_is_not_counted(machine):
    home, env = machine
    put(home, ".claude/projects/p/s.jsonl", jsonl([{"type": "user", "message": {"content": "key __ZN_AWS_KEY_1__ and __ZN_REDACTED_ANTHROPIC_KEY__"}}]))
    assert history(home=home, env=env)["findings"] == []


def test_a_line_longer_than_one_chunk_is_scanned_whole(machine):
    home, env = machine
    pad = "x " * 750000
    put(home, ".codex/sessions/s.jsonl", jsonl([{"text": pad + " " + AWS + " " + pad}, {"text": AWS}]))
    r = history(home=home, env=env)
    assert next(f for f in r["findings"] if f["type"] == "AWS_KEY")["count"] == 2


def test_plain_text_lines_are_scanned_too(machine):
    home, env = machine
    put(home, ".claude/history.jsonl", "not json: " + AWS + "\n{broken " + GITHUB + "\n")
    r = history(home=home, env=env)
    assert sorted(f["type"] for f in r["findings"]) == ["AWS_KEY", "GITHUB_TOKEN"]


def test_a_line_over_the_cap_is_skipped_and_listed(machine, monkeypatch):
    home, env = machine
    monkeypatch.setattr(reach_history, "MAX_LINE_BYTES", 2048)
    put(home, ".claude/history.jsonl", "a" * 5000 + "\n" + AWS + "\n")
    r = history(home=home, env=env)
    assert r["incomplete"] == [{"agent": "claude-code", "file": "~/.claude/history.jsonl", "reason": "line-too-long"}]
    assert next(f for f in r["findings"] if f["type"] == "AWS_KEY")["count"] == 1


@pytest.mark.skipif(not hasattr(os, "symlink") or sys.platform == "win32", reason="symbolic links")
def test_links_are_never_followed_out_of_home(machine, tmp_path):
    home, env = machine
    outside = tmp_path / "outside"
    put(outside, "x/stolen.jsonl", jsonl([{"text": AWS}]))
    put(outside, "secret.jsonl", jsonl([{"text": GITHUB}]))
    os.makedirs(os.path.join(home, ".claude/projects/p"))
    os.symlink(str(outside / "x"), os.path.join(home, ".claude/projects/linkdir"))
    os.symlink(str(outside / "secret.jsonl"), os.path.join(home, ".claude/projects/p/linkfile.jsonl"))
    os.symlink(str(outside), os.path.join(home, ".codex"))
    r = history(home=home, env=env)
    assert r["findings"] == []
    assert sorted(i["file"] + " " + i["reason"] for i in r["incomplete"]) == [
        "~/.claude/projects/linkdir symlink", "~/.claude/projects/p/linkfile.jsonl symlink", "~/.codex symlink"]
    assert next(a for a in r["agents"] if a["id"] == "codex")["scanned"] is False


def test_a_config_folder_outside_home_is_ignored(machine, tmp_path):
    home, env = machine
    outside = tmp_path / "outside"
    put(outside, "projects/p/s.jsonl", jsonl([{"text": AWS}]))
    assert history(home=home, env={**env, "CLAUDE_CONFIG_DIR": str(outside)})["findings"] == []
    put(home, "cfg/projects/p/s.jsonl", jsonl([{"text": AWS}]))
    r = history(home=home, env={**env, "CLAUDE_CONFIG_DIR": os.path.join(home, "cfg")})
    assert [f["file"] for f in r["findings"]] == ["~/cfg/projects/p/s.jsonl"]


def test_time_limit_lists_the_files_not_reached(machine):
    home, env = machine
    claude_fixture(home)
    r = history(home=home, env=env, _max_ms=-1)
    assert r["time_limit_hit"] is True
    assert r["totals"]["files_scanned"] == 0
    assert r["totals"]["files_not_reached"] == 4
    assert len(r["incomplete"]) == 4 and all(i["reason"] == "time-limit" for i in r["incomplete"])
    text = []
    report(r, text.append)
    out = "".join(text)
    assert "NOT FULLY SCANNED" in out and "time limit was reached" in out and "No secret found" not in out


def test_usage_errors_exit_2_and_a_report_exits_0(machine):
    home, env = machine
    for bad in (["--history", "."], ["--history", "--sarif"], ["--history", "--remember"], ["--history", "--fail-on", "high"],
                ["--history", "--max-seconds", "0"], ["--history", "--max-seconds", "x"], ["--max-seconds", "5"]):
        p = zn(env, "reach", *bad)
        assert p.returncode == 2, bad
        assert "usage: zn-gate reach" in p.stderr
        assert p.stdout == ""
    assert zn(env, "reach", "--history", "--max-seconds", "5").returncode == 0


def test_reach_without_history_still_points_to_npm(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["zn-gate", "reach"])
    assert cli.main() == 2
    assert "npx -y zn-gate reach" in capsys.readouterr().err


def test_help_lists_reach_history(machine):
    _home, env = machine
    assert "reach --history" in zn(env, "--help").stdout
    p = zn(env, "reach", "--help")
    assert p.returncode == 0 and "zn-gate reach --history" in p.stdout


@pytest.mark.skipif(shutil.which("node") is None or not os.path.exists(_NODE_CLI), reason="the npm package is not in this checkout")
def test_json_equals_the_npm_package(machine):
    home, env = machine
    claude_fixture(home)
    # A marker, a clean file and a config folder outside the folder are part of the same fixture.
    put(home, ".claude/projects/-proj-b/m.jsonl", jsonl([{"text": "kept __ZN_REDACTED_AWS_KEY__ and __ZN_GITHUB_TOKEN_3__"}]), 1_700_000_050)
    py = json.loads(zn(env, "reach", "--history", "--json").stdout)
    node_env = {k: v for k, v in env.items() if k != "PYTHONPATH"}
    node = subprocess.run(["node", _NODE_CLI, "reach", "--history", "--json"], capture_output=True, text=True, env=node_env, timeout=120)
    assert node.returncode == 0, node.stderr
    js = json.loads(node.stdout)
    py.pop("elapsed_ms")
    js.pop("elapsed_ms")
    assert py == js
    assert list(py) == list(js)
    # Same text output too.
    pt = zn(env, "reach", "--history").stdout
    nt = subprocess.run(["node", _NODE_CLI, "reach", "--history"], capture_output=True, text=True, env=node_env, timeout=120).stdout
    assert pt == nt
