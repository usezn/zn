"""Word helpers of zn_gate.destructive: _decode_ansi_c, _program_name and _out_flag (behaviour as it is today)."""
import pytest

from zn_gate.destructive import _decode_ansi_c, _out_flag, _program_name


@pytest.mark.parametrize(
    "cmd, expected",
    [
        ("$'\\x63url' x", "'curl' x"),
        ("$'\\x6' x", "'\x06' x"),
        ("$'\\143url'", "'curl'"),
        ("$'\\1411'", "'a1'"),
        ("$'\\777'", "'\xff'"),
        ("$'a\\nb'", "'a\nb'"),
        ("$'a\\tb'", "'a\tb'"),
        ("$'\\u0063\\U00000075'", "'cu'"),
        ("$'\\U00110000'", "''"),
        ("$'it\\'s'", "'it'\\''s'"),
        ("$'a\\qb'", "'a\\qb'"),
        ("$'ab\\x00cd'", "'ab'"),
        ("plain word", "plain word"),
        ('$"abc"', '"abc"'),
    ],
)
def test_decode_ansi_c(cmd, expected):
    assert _decode_ansi_c(cmd) == expected


@pytest.mark.parametrize(
    "text, expected",
    [
        ("rm", "rm"),
        ("/usr/bin/RM", "rm"),
        ("\\rm", "rm"),
        ("C:\\tools\\Curl.EXE", "curl"),
        ("/opt/example/bin/sh.exe", "sh"),
        ("./tool.exe.exe", "tool.exe"),
        ("", ""),
    ],
)
def test_program_name(text, expected):
    assert _program_name(text) == expected


@pytest.mark.parametrize("flag", ["-o", "-O", "-qO", "-fsSLo", "--output", "--output-document", "-out", "-OutFile", "-outf", "-OUTFILE"])
def test_out_flag_true(flag):
    assert _out_flag(flag) is True


@pytest.mark.parametrize("flag", ["o", "-", "--out", "--output=x", "-oX", "-o ", "--outputs", "-outfiles", "-1o", "output"])
def test_out_flag_false(flag):
    assert _out_flag(flag) is False
