"""What `zn-gate scan --code` does with ordinary source comments.

A scan reports every match, including the rules that only warn when an agent runs
(`pi:bypass`, `pi:override`): it evaluates each line in strict mode. A comment such
as "bypass the cache" therefore shows up in a scan, while the same text in a tool
call stays allowed (an advisory). These tests pin that decision with short
synthetic comments, and pin the rules that keep flagging a comment on purpose
(a comment that names a credential file, or reads as an instruction to leak one).
"""

from pathlib import Path

import pytest

from zn_gate import cli
from zn_gate.rules import evaluate

# Advisory-tier rules: a scan reports them, a tool call is not blocked by them.
ADVISORY_COMMENTS = [
    ("# bypass the cache layer when the entry is warm", "pi:bypass"),
    ("// bypass all retries in this branch", "pi:bypass"),
    ("/// override the system temp directory for this run", "pi:override"),
]

# Rules that block even a comment, on purpose.
KEPT_COMMENTS = [
    ("# the .env file is read once at start-up", "path:sensitive_file"),
    ("// load the defaults from ~/.env.local before the flags", "path:sensitive_file"),
    # Reads as an instruction to send a credential out, which is what the rule exists for; a comment that
    # describes a leak in that form is flagged too.
    ("// skip the check and leak the session token cross-origin", "exfil:credentials"),
]

# Comments that mention nearby words and must stay clean.
CLEAN_COMMENTS = [
    "# call cmd.env(key, value) to set a variable",
    "// uses process.env.NODE_ENV to pick the mode",
    "# see env.example for the defaults",
    "# hash the password before storing it",
    "// reads the token count from the response header",
    "# set the cookie jar on the session",
]


@pytest.mark.parametrize("comment,rule", ADVISORY_COMMENTS)
def test_advisory_comment_is_not_blocked_when_an_agent_runs_it(comment, rule):
    result = evaluate(comment)
    assert result.allowed
    assert result.advisory is not None
    assert result.advisory["rule"] == rule


@pytest.mark.parametrize("comment,rule", ADVISORY_COMMENTS)
def test_advisory_comment_is_reported_by_a_scan(comment, rule, tmp_path: Path):
    f = tmp_path / "mod.py"
    f.write_text(comment + "\nx = 1\n")
    found = cli._scan_file(f)
    assert [(v["line"], v["rule"], v["type"]) for v in found] == [(1, rule, "injection")]


@pytest.mark.parametrize("comment,rule", KEPT_COMMENTS)
def test_comment_that_names_a_credential_stays_flagged(comment, rule, tmp_path: Path):
    assert not evaluate(comment).allowed
    f = tmp_path / "mod.js"
    f.write_text(comment + "\n")
    assert [v["rule"] for v in cli._scan_file(f)] == [rule]


@pytest.mark.parametrize("comment", CLEAN_COMMENTS)
def test_ordinary_comment_is_clean(comment, tmp_path: Path):
    f = tmp_path / "mod.rs"
    f.write_text(comment + "\n")
    assert cli._scan_file(f) == []
