"""
Every command in known_commands has a parser, appears once in the help
text, and has a section in docs/cli.md. The help lists the commands in the
order they were registered in build_parser.
"""

import argparse
import io
import re
from contextlib import redirect_stdout
from pathlib import Path

from zn_gate.cli import build_parser, known_commands

_DOCS = Path(__file__).resolve().parents[3] / "docs" / "cli.md"
_EXPECTED_ORDER = ["test", "analyze", "scan", "evidence", "status", "stats"]


def _subparsers_action(parser):
    return next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))


def _help_text():
    out = io.StringIO()
    with redirect_stdout(out):
        build_parser().print_help()
    return out.getvalue()


def test_every_known_command_has_a_parser_and_the_reverse():
    parser = build_parser()
    choices = _subparsers_action(parser).choices
    assert known_commands(parser) == frozenset(choices)
    for name, sub in choices.items():
        assert isinstance(sub, argparse.ArgumentParser)
        assert sub.prog == f"zn-gate {name}"


def test_each_command_is_listed_once_in_the_help_text():
    text = _help_text()
    for name in known_commands(build_parser()):
        rows = re.findall(rf"^ {{4}}{re.escape(name)}(?: |$)", text, re.M)
        assert len(rows) == 1, name


def test_help_lists_commands_in_registration_order():
    parser = build_parser()
    assert list(_subparsers_action(parser).choices) == _EXPECTED_ORDER
    text = _help_text()
    rows = re.findall(r"^ {4}(\w+) {2,}\S", text, re.M)
    assert rows == _EXPECTED_ORDER
    assert re.search(r"\{" + ",".join(_EXPECTED_ORDER) + r"\}", text)


def test_each_command_has_a_section_in_the_cli_docs():
    headings = re.findall(r"^### `([^`]+)`", _DOCS.read_text(encoding="utf-8"), re.M)
    for name in known_commands(build_parser()):
        assert headings.count(name) == 1, name
