"""The Python package section of docs/cli.md matches the parser in zn_gate.cli."""
import re
from pathlib import Path

import pytest

from zn_gate import cli

DOCS = Path(__file__).resolve().parents[3] / "docs" / "cli.md"


def _section_rows():
    if not DOCS.is_file():
        pytest.skip("docs/cli.md is not available")
    text = DOCS.read_text(encoding="utf-8")
    section = text.split("## The Python package", 1)[1]
    rows = {}
    for line in section.splitlines():
        m = re.match(r"\|\s*`([a-z]+)[^`]*`\s*\|([^|]*(?:\\\|[^|]*)*)\|", line)
        if m:
            rows[m.group(1)] = m.group(2)
    return rows


def _subparsers():
    parser = cli.build_parser()
    return parser.get_default("_subparsers").choices


def test_docs_name_the_same_commands_as_the_parser():
    assert set(_section_rows()) == set(_subparsers())
    assert len(_subparsers()) == 7


@pytest.mark.parametrize("command", sorted(["test", "analyze", "scan", "evidence", "status", "stats", "check"]))
def test_documented_options_exist_in_the_command_parser(command):
    options_cell = _section_rows()[command]
    documented = set(re.findall(r"`(--[a-z-]+)", options_cell))
    sub = _subparsers()[command]
    registered = {o for a in sub._actions for o in a.option_strings}
    assert documented <= registered, documented - registered
    if command not in ("status", "check"):
        assert documented
