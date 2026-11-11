"""require_human: the guard for commands only a person may run (twin of the npm package's lib/broker/tty.js)."""

import io

import pytest

from zn_gate import human


class _Tty(io.StringIO):
    def isatty(self):
        return True


def _clean_ancestry():
    return None


def _call(stdin=None, stdout=None, env=None, ancestry=_clean_ancestry):
    human.require_human("zn-gate evidence --accept", stdin=stdin or _Tty(), stdout=stdout or _Tty(),
                        env={} if env is None else env, ancestry=ancestry)


def test_terminal_clean_env_clean_ancestry_is_allowed():
    _call()


@pytest.mark.parametrize("var", human.AGENT_ENV_VARS)
def test_agent_env_var_is_refused(var):
    with pytest.raises(human.HumanRequired, match="not by an AI agent"):
        _call(env={var: "1"})


def test_empty_agent_env_var_still_counts():
    with pytest.raises(human.HumanRequired):
        _call(env={"CLAUDECODE": ""})


def test_env_list_matches_npm_package():
    assert human.AGENT_ENV_VARS == ("CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED",
                                    "CURSOR_AGENT", "OPENCODE", "ZN_AGENT")


def test_non_tty_stdin_is_refused():
    with pytest.raises(human.HumanRequired, match="interactive terminal"):
        _call(stdin=io.StringIO())


def test_non_tty_stdout_is_refused():
    with pytest.raises(human.HumanRequired, match="interactive terminal"):
        _call(stdout=io.StringIO())


def test_agent_in_ancestry_is_refused():
    with pytest.raises(human.HumanRequired, match="started from claude"):
        _call(ancestry=lambda: "claude")


def test_ancestry_is_checked_even_when_variables_were_removed():
    table = {
        100: {"pid": 100, "ppid": 50, "name": "python3", "argv": ["python3", "-m", "zn_gate"]},
        50: {"pid": 50, "ppid": 10, "name": "bash", "argv": ["bash"]},
        10: {"pid": 10, "ppid": 1, "name": "node", "argv": ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"]},
        1: {"pid": 1, "ppid": 0, "name": "init", "argv": ["init"]},
    }
    assert human.walk(100, table.get) == "claude"
    with pytest.raises(human.HumanRequired, match="started from claude"):
        _call(ancestry=lambda: human.walk(100, table.get))


def test_editor_terminal_is_not_an_agent():
    table = {
        100: {"pid": 100, "ppid": 50, "name": "python3", "argv": ["python3"]},
        50: {"pid": 50, "ppid": 10, "name": "zsh", "argv": ["zsh"]},
        10: {"pid": 10, "ppid": 1, "name": "Cursor", "argv": ["/Applications/Cursor.app/Contents/MacOS/Cursor"]},
        1: {"pid": 1, "ppid": 0, "name": "launchd", "argv": ["launchd"]},
    }
    assert human.walk(100, table.get) is None
    _call(ancestry=lambda: human.walk(100, table.get))


@pytest.mark.parametrize("proc,expected", [
    ({"name": "claude", "argv": ["claude"]}, "claude"),
    ({"name": "codex.exe", "argv": ["C:\\bin\\codex.exe", "x"]}, "codex"),
    ({"name": "node", "argv": ["node", "/x/opencode-ai/bin/opencode"]}, "opencode"),
    ({"name": "2.1.0", "argv": ["/home/u/.local/share/claude/versions/2.1.0"]}, "claude"),
    ({"name": "node", "argv": ["node", "server.js"]}, None),
    ({"name": "cursor-agent", "argv": ["cursor-agent"]}, "cursor-agent"),
])
def test_agent_of(proc, expected):
    assert human.agent_of(proc) == expected


def test_walk_stops_on_loop_and_unreadable_parent():
    loop = {5: {"pid": 5, "ppid": 6, "name": "a", "argv": ["a"]}, 6: {"pid": 6, "ppid": 5, "name": "b", "argv": ["b"]}}
    assert human.walk(5, loop.get) is None
    assert human.walk(5, lambda p: {"pid": 5, "ppid": 6, "name": "a", "argv": ["a"]} if p == 5 else None) is None


def test_walk_rejects_reused_parent_id_on_windows():
    table = {
        3: {"pid": 3, "ppid": 2, "name": "python.exe", "argv": ["python.exe"], "created": 100},
        2: {"pid": 2, "ppid": 0, "name": "claude.exe", "argv": ["claude.exe"], "created": 200},
    }
    assert human.walk(3, table.get) is None


def test_parse_stat_with_parentheses_in_name():
    assert human.parse_stat("42 (a (b) c) S 7 42 42 0") == {"name": "a (b) c", "ppid": 7}


def test_parse_ps_and_cim():
    ps = human.parse_ps("  10     1 claude   claude --x\n 20 10 python3 python3 -m zn_gate\n")
    assert human.walk(20, ps.get) == "claude"
    cim = human.parse_cim('[{"ProcessId":3,"ParentProcessId":2,"Name":"py.exe","CommandLine":"\\"C:\\\\p\\\\py.exe\\" a","Created":200},'
                          '{"ProcessId":2,"ParentProcessId":0,"Name":"codex.exe","CommandLine":"codex.exe","Created":100}]')
    assert human.walk(3, cim.get) == "codex"
    assert human.parse_cim("not json") == {}


def test_unreadable_process_table_reports_nothing(monkeypatch):
    monkeypatch.setattr(human, "_ps_table", lambda: None)
    assert human.agent_ancestor(pid=1, platform="darwin") is None
