"""The help text of the top-level command and of every subcommand."""
import re

import pytest

from zn_gate.cli import NPM_ONLY_COMMANDS, build_parser, known_commands

_NAMES = sorted(known_commands(build_parser()))


def _help_texts(parser):
    subparsers = parser.get_default("_subparsers")
    texts = {"(top level)": parser.format_help()}
    for name in _NAMES:
        texts[name] = subparsers.choices[name].format_help()
    return texts


@pytest.fixture(params=["80", "100"])
def texts(request, monkeypatch):
    monkeypatch.setenv("COLUMNS", request.param)
    return _help_texts(build_parser())


def test_help_fits_in_100_columns(texts):
    for name, text in texts.items():
        for line in text.splitlines():
            assert len(line) <= 100, (name, line)


def test_help_is_plain_ascii(texts):
    for name, text in texts.items():
        assert text.isascii(), (name, [c for c in text if not c.isascii()])


def test_help_mentions_no_npm_only_command(texts):
    for name, text in texts.items():
        assert "npx" not in text and "npm" not in text, name
        for cmd in sorted(NPM_ONLY_COMMANDS):
            pattern = r"(?<![\w-])zn-gate " + re.escape(cmd) + r"(?![\w-])"
            assert not re.search(pattern, text), (name, cmd)
            # Also not listed as a subcommand choice or a bare command word.
            assert not re.search(r"(?<![\w-])" + re.escape(cmd) + r"(?=[,}])", text), (name, cmd)
