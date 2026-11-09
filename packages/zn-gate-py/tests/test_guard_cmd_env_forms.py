# cmd.exe percent and caret forms that read a .env file, checked through the Python guard.
# The Node.js guard refuses the same forms (packages/zn-gate/test/fixtures/tool_guard_parity.json holds them too).
# BSLH stands for a backslash and DQ for a double quote, so the cases stay readable. All paths are fictional.

import pytest

from zn_gate import check_tool_call


def _cmd(text):
    return text.replace("BSLH", chr(92)).replace("DQ", chr(34))


BLOCKED = [
    "type %CD%BSLH.env",
    "type %CD%BSLH.env.local",
    "type %CD%BSLH.ENV",
    "ty^pe .env",
    "ty^pe %CD%BSLH.env",
    "type .env^",
    "type DQ%CD%BSLH.envDQ",
    "cmd /c type %CD%BSLH.env",
    "type %USERPROFILE%BSLH.env",
    # The five forms that used to be let through:
    "type .e^nv",
    "type ^.env",
    "type %CD%BSLH.e^nv",
    "cmd /c DQtype %CD%BSLH.e^nvDQ",
    "set X=.env & type %X%",
    # Close variants of the same forms:
    "more < .e^nv",
    "findstr . .e^nv",
    "type .%EMPTY%env",
]

ALLOWED = [
    "type %CD%BSLH.env.example",
    "type %CD%BSLH.notes.md",
    "type notes.md",
    "type DQ.e^nvDQ",
    "type README.md",
    "echo 100%",
    "type notes^.txt",
    "set X=notes.md & type %X%",
    "cmd /c DQtype notes^.txtDQ",
    "grep ^.env notes.md",
]


@pytest.mark.parametrize("text", BLOCKED)
def test_cmd_percent_and_caret_form_reading_env_is_blocked(text):
    res = check_tool_call("shell", {"command": _cmd(text)})
    assert res.verdict == "block", res.rule
    assert res.rule == "path:sensitive_file"


@pytest.mark.parametrize("text", ALLOWED)
def test_cmd_form_that_names_no_env_file_is_allowed(text):
    res = check_tool_call("shell", {"command": _cmd(text)})
    assert res.verdict == "allow", res.rule
