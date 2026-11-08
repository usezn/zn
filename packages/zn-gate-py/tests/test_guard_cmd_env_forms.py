# cmd.exe percent and caret forms that read a .env file, checked through the Python guard.
# The Node.js policy refuses the same forms (packages/zn-gate/test/policy_hidden_env_forms.test.js).
# BSLH stands for a backslash and DQ for a double quote, so the cases stay readable. All paths are fictional.
# Forms the Python guard does not refuse yet are xfail (strict): a fix turns them into XPASS.

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
]

ALLOWED = [
    "type %CD%BSLH.env.example",
    "type %CD%BSLH.notes.md",
    "type notes.md",
    "type DQ.e^nvDQ",
]

GAPS = [
    ("type .e^nv", "parity gap with the Node policy: caret inside the .env name, unquoted; cmd.exe drops the caret and reads .env"),
    ("type ^.env", "parity gap with the Node policy: caret before the dot; cmd.exe drops it and reads .env"),
    ("type %CD%BSLH.e^nv", "parity gap with the Node policy: percent path with a caret inside the .env name"),
    ("cmd /c DQtype %CD%BSLH.e^nvDQ", "parity gap with the Node policy: quoted cmd /c command with a caret inside the .env name"),
    ("set X=.env & type %X%", "parity gap with the Node policy: percent variable that holds the .env name"),
]

BLOCK_CASES = BLOCKED + [pytest.param(text, marks=pytest.mark.xfail(strict=True, reason=reason)) for text, reason in GAPS]


@pytest.mark.parametrize("text", BLOCK_CASES)
def test_cmd_percent_and_caret_form_reading_env_is_blocked(text):
    res = check_tool_call("shell", {"command": _cmd(text)})
    assert res.verdict == "block", res.rule
    assert res.rule == "path:sensitive_file"


@pytest.mark.parametrize("text", ALLOWED)
def test_cmd_form_that_names_no_env_file_is_allowed(text):
    res = check_tool_call("shell", {"command": _cmd(text)})
    assert res.verdict == "allow", res.rule
