"""zn-gate reach --history in the Python package: same behaviour and same --json as the npm package.

All values below are obviously fake and are put together at run time.
"""
import json
import os
import re
import shutil
import subprocess
import sys

import pytest

from zn_gate.shell_names import npx_name
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
    assert [a["id"] for a in r["agents"]] == ["claude-code", "codex", "cursor", "opencode", "gemini-cli", "copilot", "antigravity", "zcode"]
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


@pytest.mark.skipif(sys.platform == "win32",
                    reason="the test builds POSIX-style symbolic links; Windows is not covered here")
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


def test_a_config_folder_inside_home_is_shown_relative_to_home(machine):
    home, env = machine
    put(home, "cfg/projects/p/s.jsonl", jsonl([{"text": AWS}]))
    r = history(home=home, env={**env, "CLAUDE_CONFIG_DIR": os.path.join(home, "cfg")})
    assert [f["file"] for f in r["findings"]] == ["~/cfg/projects/p/s.jsonl"]


def test_a_config_folder_named_by_the_environment_is_honoured_wherever_it_points(machine, tmp_path):
    home, env = machine
    outside = tmp_path / "outside"
    put(outside, "projects/p/s.jsonl", jsonl([{"text": AWS}]))
    put(outside, "codexhome/sessions/2026/s.jsonl", jsonl([{"text": GITHUB}]))
    r = history(home=home, env={**env, "CLAUDE_CONFIG_DIR": str(outside), "CODEX_HOME": str(outside / "codexhome")})
    assert next(a for a in r["agents"] if a["id"] == "claude-code")["scanned"] is True
    assert next(a for a in r["agents"] if a["id"] == "codex")["scanned"] is True
    assert sorted(f["agent"] + " " + f["type"] for f in r["findings"]) == ["claude-code AWS_KEY", "codex GITHUB_TOKEN"]
    assert all(home not in f["file"] and "\n" not in f["file"] for f in r["findings"])
    out = []
    report(r, out.append)
    assert "no history found" not in "".join(out)


def test_a_file_below_the_depth_limit_is_reported_naming_the_limit(machine):
    home, env = machine
    put(home, ".claude/projects/a/b/c/d/e/f/g/h/deep.jsonl", jsonl([{"text": AWS}]))
    put(home, ".claude/projects/p/ok.jsonl", jsonl([{"text": "clean"}]))
    r = history(home=home, env=env)
    deep = [i for i in r["incomplete"] if i["reason"] == "too-deep"]
    assert len(deep) == 1 and deep[0]["agent"] == "claude-code" and deep[0]["limit"] == 6
    out = []
    report(r, out.append)
    text = "".join(out)
    assert "NOT FULLY SCANNED" in text
    assert "too deep" in text and "6 levels" in text
    assert "No secret found" not in text


def test_too_many_files_is_reported_naming_the_limit(machine, monkeypatch):
    home, env = machine
    monkeypatch.setattr(reach_history, "MAX_FILES", 2)
    for n in range(4):
        put(home, ".claude/projects/p/s%d.jsonl" % n, jsonl([{"text": "clean"}]))
    r = history(home=home, env=env)
    assert any(i["reason"] == "too-many-files" and i["limit"] == 2 for i in r["incomplete"])


def test_agents_whose_history_is_not_read_are_listed_as_not_scanned_yet(machine):
    home, env = machine
    r = history(home=home, env=env)
    assert [a["id"] for a in r["agents"]] == ["claude-code", "codex", "cursor", "opencode", "gemini-cli", "copilot", "antigravity", "zcode"]
    for i in ("gemini-cli", "copilot", "antigravity", "zcode"):
        a = next(x for x in r["agents"] if x["id"] == i)
        assert a["scanned"] is False and a["reason"] == "not-yet"
    out = []
    report(r, out.append)
    text = "".join(out)
    for n in ("Gemini CLI", "Copilot", "Antigravity", "ZCode"):
        assert re.search(n + r" +not scanned yet", text)


@pytest.mark.skipif(shutil.which("node") is None or not os.path.exists(_NODE_CLI), reason="needs node on PATH and packages/zn-gate/bin/cli.js (monorepo checkout; absent in an sdist)")
def test_json_equals_the_npm_package_with_outside_config_and_deep_files(machine, tmp_path):
    home, env = machine
    outside = tmp_path / "outside"
    put(outside, "projects/p/s.jsonl", jsonl([{"text": AWS}]))
    put(outside, "projects/a/b/c/d/e/f/g/h/deep.jsonl", jsonl([{"text": AWS}]))
    put(home, ".codex/sessions/2026/s.jsonl", jsonl([{"text": GITHUB}]))
    env = {**env, "CLAUDE_CONFIG_DIR": str(outside)}
    py = json.loads(zn(env, "reach", "--history", "--json").stdout)
    node_env = {k: v for k, v in env.items() if k != "PYTHONPATH"}
    for k in ("SYSTEMROOT", "SystemRoot", "TEMP", "TMP"):
        if k in os.environ:
            node_env[k] = os.environ[k]
    node = subprocess.run(["node", _NODE_CLI, "reach", "--history", "--json"], capture_output=True, text=True, env=node_env, timeout=120)
    assert node.returncode == 0, node.stderr
    js = json.loads(node.stdout)
    py.pop("elapsed_ms")
    js.pop("elapsed_ms")
    assert py == js
    assert any(i["reason"] == "too-deep" for i in py["incomplete"])
    pt = zn(env, "reach", "--history").stdout
    nt = subprocess.run(["node", _NODE_CLI, "reach", "--history"], capture_output=True, text=True, env=node_env, timeout=120).stdout
    assert pt == nt


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
    assert npx_name() + " -y zn-gate reach" in capsys.readouterr().err


def test_help_lists_reach_history(machine):
    _home, env = machine
    assert "reach --history" in zn(env, "--help").stdout
    p = zn(env, "reach", "--help")
    assert p.returncode == 0 and "zn-gate reach --history" in p.stdout


@pytest.mark.skipif(shutil.which("node") is None or not os.path.exists(_NODE_CLI), reason="needs node on PATH and packages/zn-gate/bin/cli.js (monorepo checkout; absent in an sdist)")
def test_json_equals_the_npm_package(machine):
    home, env = machine
    claude_fixture(home)
    # A marker, a clean file and a config folder outside the folder are part of the same fixture.
    put(home, ".claude/projects/-proj-b/m.jsonl", jsonl([{"text": "kept __ZN_REDACTED_AWS_KEY__ and __ZN_GITHUB_TOKEN_3__"}]), 1_700_000_050)
    py = json.loads(zn(env, "reach", "--history", "--json").stdout)
    node_env = {k: v for k, v in env.items() if k != "PYTHONPATH"}
    # Windows: node needs SYSTEMROOT (and a TEMP folder) to start; the stripped test env has neither.
    for k in ("SYSTEMROOT", "SystemRoot", "TEMP", "TMP"):
        if k in os.environ:
            node_env[k] = os.environ[k]
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


def _clock(ok_calls):
    """A fake clock: the first ok_calls reads say 'before the deadline', every later one 'long past it'."""
    state = {"n": 0}

    def now():
        state["n"] += 1
        return 0 if state["n"] <= ok_calls else 10 ** 15
    return now, state


def _write(tmp_path, text):
    p = tmp_path / "f.jsonl"
    p.write_text(text, encoding="utf-8", newline="")
    return str(p)


def test_a_file_read_to_the_end_is_complete_even_if_the_deadline_passes_before_the_empty_read(tmp_path, monkeypatch):
    path = _write(tmp_path, "first line\nmy key " + AWS)  # no final newline: the last line is flushed at EOF
    now, _ = _clock(1)  # the deadline passes right after the only chunk was read
    monkeypatch.setattr(reach_history, "_now_ms", now)
    r = reach_history.scan_file(path, deadline=1)
    assert r["complete"] is True and r["reason"] is None
    assert sum(r["counts"].values()) == 1


def test_a_deadline_in_the_middle_of_a_file_reports_time_limit_with_partial_results(tmp_path, monkeypatch):
    line = "key " + AWS + "\n"
    path = _write(tmp_path, line * 40)
    monkeypatch.setattr(reach_history, "CHUNK", len(line) * 5)
    now, _ = _clock(2)  # two chunks are scanned, the third read finds the deadline passed
    monkeypatch.setattr(reach_history, "_now_ms", now)
    r = reach_history.scan_file(path, deadline=1)
    assert r["complete"] is False and r["reason"] == "time-limit"
    assert sum(r["counts"].values()) == 10  # the two scanned chunks hold 5 lines each; the rest is not read


def test_one_very_long_line_stops_within_a_bounded_amount_after_the_deadline(tmp_path, monkeypatch):
    from zn_gate import rules
    path = _write(tmp_path, ("filler words " * 40 + AWS + " ") * 200 + "\n")
    monkeypatch.setattr(reach_history, "SLICE_CHARS", 1000)
    calls = {"n": 0}
    real = rules.redact_secrets

    def counting(text):
        calls["n"] += 1
        return real(text)
    monkeypatch.setattr(rules, "redact_secrets", counting)
    now, _ = _clock(2)  # chunk check, then the first slice boundary; the second boundary is past the deadline
    monkeypatch.setattr(reach_history, "_now_ms", now)
    r = reach_history.scan_file(path, deadline=1)
    assert r["complete"] is False and r["reason"] == "time-limit"
    assert calls["n"] <= 3  # of about 100 slices: slice 1, then slice 2 and the overlap it shares with slice 1


def test_slicing_a_long_line_gives_the_same_counts_as_scanning_it_whole(tmp_path, monkeypatch):
    text = ("filler words " * 40 + AWS + " " + GITHUB + " ") * 50 + "\n"
    path = _write(tmp_path, text)
    whole = reach_history.scan_file(path, deadline=10 ** 18)
    monkeypatch.setattr(reach_history, "SLICE_CHARS", 2000)
    sliced = reach_history.scan_file(path, deadline=10 ** 18)
    assert whole["complete"] and sliced["complete"]
    assert whole["counts"] == sliced["counts"] and sum(whole["counts"].values()) == 100


# Long lines at the real slice size. The filler has no space or line break, so the first cut falls exactly at
# SLICE_CHARS, and its characters are outside the token alphabet, so they do not stick to a key. Same cases as the
# npm tests of the same names.
def _github_count(text):
    from zn_gate import rules
    types = reach_history._types()
    return sum(1 for d in rules.redact_secrets(text)[1] if types.get(d["rule"]) == "GITHUB_TOKEN")


def test_a_secret_across_a_slice_cut_of_a_long_line_is_found_exactly_once(tmp_path):
    s = reach_history.SLICE_CHARS
    before = ";" * (s - 17)
    text = before + GITHUB + ";" * 200000
    assert reach_history._cuts(text)[:2] == [0, s]  # the cut is inside the key
    assert len(before) < s < len(before) + len(GITHUB)
    assert _github_count(text[:s]) + _github_count(text[s:]) == 0  # without the overlap, neither slice sees it
    r = reach_history.scan_file(_write(tmp_path, text + "\n"), deadline=10 ** 18)
    assert r["complete"] is True
    assert r["counts"] == {"GITHUB_TOKEN": 1}


def test_a_secret_inside_one_slice_or_inside_the_overlap_of_two_is_found_exactly_once(tmp_path):
    s = reach_history.SLICE_CHARS
    o = reach_history._overlap_chars()
    parts = [";" * 1000, AWS, ";" * (s - 1000 - len(AWS) + 5000), AWS]
    sofar = len("".join(parts))
    parts += [";" * (s + o - 17 - sofar), GITHUB, ";" * 100000, AWS, ";" * 10000]
    text = "".join(parts)
    assert reach_history._cuts(text)[1] == s
    assert text.index(GITHUB) < s + o < text.index(GITHUB) + len(GITHUB)
    r = reach_history.scan_file(_write(tmp_path, text + "\n"), deadline=10 ** 18)
    assert r["complete"] is True
    assert r["counts"] == {"AWS_KEY": 3, "GITHUB_TOKEN": 1}


def test_the_overlap_comes_from_the_secret_rules_and_holds_the_longest_of_them_twice():
    from zn_gate import rules
    tables = rules.SCRUB_FIRST_PATTERNS + rules.SECRET_PATTERNS + rules.PROVIDER_SECRET_PATTERNS + rules.SCRUB_LAST_PATTERNS
    longest = reach_history._longest_secret_match([p.pattern for _, p, _ in tables])
    assert longest >= 4096
    assert reach_history._overlap_chars() == max(64 * 1024, 2 * longest)
    assert reach_history._overlap_chars() == 64 * 1024  # the same overlap as the npm package
    assert reach_history._longest_secret_match(["a{2,40}b{3}c{5,}"]) == 16 + 40 + 3 + 5


def test_a_home_over_the_file_cap_keeps_the_same_files_as_npm(machine):
    # Same corpus and same expected files as the npm test of the same name. Names are compared by UTF-8 bytes:
    # U+1F600 is after U+FF01 in code points, so it is the file left out at a cap of 5.
    home, env = machine
    names = ["B.jsonl", "a.jsonl", "z.jsonl", "\u00e9.jsonl", "\uff01.jsonl", "\U0001f600.jsonl"]
    for n in names:
        put(home, ".claude/projects/p/" + n, jsonl([{"text": "key " + AWS}]))
    r = history(home=home, env=env, _max_files=5)
    files = sorted({f["file"].split("/")[-1] for f in r["findings"]})
    assert files == sorted(["B.jsonl", "a.jsonl", "z.jsonl", "\u00e9.jsonl", "\uff01.jsonl"])
    assert any(i["reason"] == "too-many-files" and i["limit"] == 5 for i in r["incomplete"])


# Types that only the scrub tables know, and the types the generic rules give. All values are fake, built at run time.
TWILIO = "TWILIO_AUTH_" + "TOKEN=" + "0123456789abcdef" * 2
ZN_KEY = "zn" + "_" + "0123456789abcdef" * 3
PAT = "github" + "_pat_" + "A1b2C3d4E5f6G7h8I9j0K1" + "_" + "L2m3N4o5P6q7R8s9T0u1V2w3X4y5Z6a7B8c9D0e1F2g3H4i5J6k7L8m9N0o"
GENERIC_LINES = [
    "export DATABASE_" + "PASSWORD=Zq8Lk3Xv9Rt2Wm",
    "MYAPP_SECRET_" + "KEY=Zq8Lk3Xv9Rt2WmPq7Ab",
    "API_" + "TOKEN=Zq8Lk3Xv9Rt2WmPq7AbCd4Ef",
]


def _types_of(env, home):
    out = json.loads(zn(env, "reach", "--history", "--json").stdout)
    seen = {}
    for f in out["findings"]:
        seen[f["type"]] = seen.get(f["type"], 0) + f["count"]
    return seen


def test_scrub_table_types_are_counted(machine):
    home, env = machine
    put(home, ".claude/projects/-proj-t/s.jsonl", jsonl([
        {"type": "user", "message": {"content": "my " + TWILIO + " is set"}},
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "key " + ZN_KEY + " here"}]}},
        {"type": "user", "message": {"content": "pat " + PAT + " ok"}},
    ]))
    seen = _types_of(env, home)
    assert seen.get("TWILIO_AUTH_TOKEN") == 1
    assert seen.get("ZN_API_KEY") == 1
    assert seen.get("GITHUB_PAT") == 1
    assert "GITHUB_TOKEN" not in seen
    out = zn(env, "reach", "--history").stdout
    assert "No secret found" not in out
    assert "0123456789abcdef0123456789abcdef" not in out


CLASSIC = "gh" + "p_" + "FAKE0123456789abcdefFAKE0123456789ab"
PAT_ZW = PAT[:20] + "​" + PAT[20:]


def _pat_variants():
    return [PAT[:20] + c + PAT[20:] for c in ("​", "‌", "⁠", "﻿")]


def test_an_invisible_character_inside_a_fine_grained_token_does_not_change_its_type():
    for v in _pat_variants():
        counts = {}
        reach_history.scan_line("pat " + v + " ok", counts)
        assert counts == {"GITHUB_PAT": 1}, (repr(v[20]), counts)


def test_a_line_with_a_fine_grained_and_a_classic_token_counts_one_of_each():
    for v in [PAT, PAT_ZW]:
        counts = {}
        reach_history.scan_line("pat " + v + " and classic " + CLASSIC, counts)
        assert counts == {"GITHUB_PAT": 1, "GITHUB_TOKEN": 1}, counts


@pytest.mark.skipif(shutil.which("node") is None or not os.path.exists(_NODE_CLI), reason="needs node on PATH and packages/zn-gate/bin/cli.js (monorepo checkout; absent in an sdist)")
def test_invisible_characters_in_a_fine_grained_token_equal_the_npm_package(machine):
    home, env = machine
    lines = ["pat " + v + " ok" for v in _pat_variants()] + ["pat " + PAT + " and classic " + CLASSIC, "pat " + PAT_ZW + " and classic " + CLASSIC]
    put(home, ".claude/projects/-proj-z/s.jsonl", jsonl([{"text": x} for x in lines]))
    py = json.loads(zn(env, "reach", "--history", "--json").stdout)
    node_env = {k: v for k, v in env.items() if k != "PYTHONPATH"}
    for k in ("SYSTEMROOT", "SystemRoot", "TEMP", "TMP"):
        if k in os.environ:
            node_env[k] = os.environ[k]
    node = subprocess.run(["node", _NODE_CLI, "reach", "--history", "--json"], capture_output=True, text=True, env=node_env, timeout=120)
    assert node.returncode == 0, node.stderr
    js = json.loads(node.stdout)
    py.pop("elapsed_ms")
    js.pop("elapsed_ms")
    assert py == js
    types = {f["type"]: f["count"] for f in py["findings"]}
    assert types == {"GITHUB_PAT": 6, "GITHUB_TOKEN": 2}, types


def test_an_unknown_rule_id_is_counted_as_a_generic_secret(monkeypatch):
    from zn_gate import rules
    monkeypatch.setattr(rules, "redact_secrets", lambda text: (text, [{"rule": "secret:future_rule", "start": 0, "end": 4}]))
    counts = {}
    reach_history.scan_line("a line with eight or more characters", counts)
    assert counts == {"SECRET": 1}


def test_every_scrub_rule_has_a_type():
    from zn_gate import rules
    types = reach_history._types()
    for table in (rules.SCRUB_FIRST_PATTERNS, rules.SCRUB_LAST_PATTERNS):
        for rule_id, _pattern, _replacement in table:
            assert rule_id.partition("#")[0] in types


@pytest.mark.skipif(shutil.which("node") is None or not os.path.exists(_NODE_CLI), reason="needs node on PATH and packages/zn-gate/bin/cli.js (monorepo checkout; absent in an sdist)")
def test_types_and_counts_equal_the_npm_package_for_scrub_and_generic_forms(machine):
    home, env = machine
    lines = [TWILIO, ZN_KEY, PAT, GITHUB, AWS] + GENERIC_LINES
    put(home, ".claude/projects/-proj-p/s.jsonl", jsonl([{"text": x} for x in lines]))
    py = json.loads(zn(env, "reach", "--history", "--json").stdout)
    node_env = {k: v for k, v in env.items() if k != "PYTHONPATH"}
    for k in ("SYSTEMROOT", "SystemRoot", "TEMP", "TMP"):
        if k in os.environ:
            node_env[k] = os.environ[k]
    node = subprocess.run(["node", _NODE_CLI, "reach", "--history", "--json"], capture_output=True, text=True, env=node_env, timeout=120)
    assert node.returncode == 0, node.stderr
    js = json.loads(node.stdout)
    py.pop("elapsed_ms")
    js.pop("elapsed_ms")
    assert py == js
    types = {f["type"]: f["count"] for f in py["findings"]}
    assert {"TWILIO_AUTH_TOKEN", "ZN_API_KEY", "GITHUB_PAT", "GITHUB_TOKEN", "AWS_KEY", "SECRET"} <= set(types)


def test_the_scan_report_escapes_terminal_controls_in_reason_and_snippet(capsys):
    esc = chr(27)
    violation = {"file": "a.txt", "line": 1, "rule": "secret:x", "type": "secret_leak",
                 "reason": "bad " + esc + "[31mred", "content": "snippet " + esc + "[2Jclear"}
    cli._print_report("text", 1, [], [violation])
    out = capsys.readouterr().out
    assert esc not in out
    assert (chr(92) + "x1b[31mred") in out and (chr(92) + "x1b[2Jclear") in out


def test_a_rule_id_in_two_tables_reports_one_type_like_the_npm_package():
    """The npm package reports the type of the pattern that matched. Here the type is looked up by rule id, so every id
    that two tables share must carry the same type in both: then the first entry wins and nothing differs from npm."""
    from zn_gate import rules
    marker = re.compile(r"\[REDACTED_([A-Z0-9_]+)\]")
    found = {}
    for table in (rules.SECRET_PATTERNS, rules.PROVIDER_SECRET_PATTERNS,
                  rules.SCRUB_FIRST_PATTERNS, rules.SCRUB_LAST_PATTERNS):
        for rule_id, _pattern, replacement in table:
            m = marker.search(replacement)
            if m:
                found.setdefault(rule_id.partition("#")[0], set()).add(m.group(1))
    shared = {k: v for k, v in found.items() if len(v) > 1}
    assert not shared, shared
    types = reach_history._types()
    assert types["secret:openai_key"] == "OPENAI_KEY"
    assert types["secret:github_token"] == "GITHUB_TOKEN"
