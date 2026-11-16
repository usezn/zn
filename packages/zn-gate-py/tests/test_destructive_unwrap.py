"""_unwrap strips launcher prefixes (sudo, env, nice, time) and returns the rest of the words;
for bash -c and sh -c the inner command text stays as one word."""
import pytest

from zn_gate.destructive import _segments_of, _unwrap


def test_sudo_with_flags():
    assert _unwrap(["sudo", "-E", "rm", "-rf", "/tmp/example-dir"]) == ["rm", "-rf", "/tmp/example-dir"]


def test_sudo_flag_with_argument():
    assert _unwrap(["sudo", "-u", "builder", "rm", "/tmp/example-file"]) == ["rm", "/tmp/example-file"]


def test_env_with_assignments():
    words = ["env", "FOO=bar", "BAZ=qux", "rm", "/tmp/example-file"]
    assert _unwrap(words) == ["rm", "/tmp/example-file"]


def test_env_unset_option_and_assignment():
    assert _unwrap(["env", "-u", "HOME", "A=1", "ls", "/tmp/example-dir"]) == ["ls", "/tmp/example-dir"]


def test_leading_assignment():
    assert _unwrap(["A=1", "rm", "/tmp/example-file"]) == ["rm", "/tmp/example-file"]


def test_nice_with_level():
    assert _unwrap(["nice", "-n", "10", "rm", "/tmp/example-file"]) == ["rm", "/tmp/example-file"]


def test_time():
    assert _unwrap(["time", "rm", "/tmp/example-file"]) == ["rm", "/tmp/example-file"]


def test_stacked_prefixes():
    words = ["sudo", "env", "X=1", "nice", "-n", "5", "time", "rm", "/tmp/example-file"]
    assert _unwrap(words) == ["rm", "/tmp/example-file"]


def test_plain_command_unchanged():
    assert _unwrap(["ls", "-la", "/tmp/example-dir"]) == ["ls", "-la", "/tmp/example-dir"]


def test_empty():
    assert _unwrap([]) == []


@pytest.mark.parametrize("shell", ["bash", "sh"])
def test_shell_c_keeps_inner_text_after_prefix(shell):
    inner = "rm -rf '/tmp/example dir' && echo \"done\""
    out = _unwrap(["sudo", "env", "A=1", shell, "-c", inner])
    assert out == [shell, "-c", inner]
    assert out[2] == inner


@pytest.mark.parametrize("shell", ["bash", "sh"])
def test_shell_c_nested_quotes_parsed_from_command_line(shell):
    cmd = f"sudo {shell} -c 'echo \"a b\" > /tmp/example-out'"
    segments, leftover = _segments_of(cmd)
    assert not leftover
    words = segments[0][0]
    assert _unwrap(words)[2] == 'echo "a b" > /tmp/example-out'
