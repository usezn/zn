"""_unwrap strips launcher prefixes (sudo, env, nice, time) and returns the rest of the words;
for bash -c and sh -c the inner command text stays as one word."""
import pytest

from zn_gate.destructive import _segments_of, _unwrap, check_command


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


TIMEOUT_FORMS = [
    "-s KILL 5", "-sKILL 5", "--signal=KILL 5", "--signal KILL 5", "-k 2 5", "-k2 5", "--kill-after=2 5", "--kill-after 2 5",
    "--preserve-status 5", "--foreground 5", "-v 5", "--verbose 5", "-vs KILL 5", "-vk 2 5", "-vsKILL 5", "-s KILL -k 2 5",
    "--foreground --preserve-status -k 2s -s TERM 1.5m", "--sig=KILL 5", "--kill=2 5", "-- 5", "-k 2 -- 5", "5s", "$DURATION",
]


@pytest.mark.parametrize("form", TIMEOUT_FORMS)
def test_timeout_options_are_skipped_with_their_values(form):
    assert _unwrap(("timeout " + form + " rm -rf /").split()) == ["rm", "-rf", "/"]
    assert _unwrap(("timeout " + form + " nohup rm -rf /").split()) == ["rm", "-rf", "/"]


@pytest.mark.parametrize("form", TIMEOUT_FORMS)
def test_timeout_options_do_not_hide_a_destructive_command(form):
    for command in ("timeout %s rm -rf /", "timeout %s nohup rm -rf /home/example-user", "nohup timeout %s sudo rm -rf /"):
        assert check_command(command % form).verdict == "block", command % form


def test_timeout_nested_wrappers_with_options():
    for command in ("timeout -k 2 5 nohup timeout -s KILL 3 rm -rf /", "timeout -s KILL 9 timeout -k 1 5 rm -rf /home/example-user"):
        assert check_command(command).verdict == "block", command


@pytest.mark.parametrize("command", [
    "timeout --bogus rm -rf /", "timeout -x 5 rm -rf /", "timeout rm -rf /", "timeout -s KILL -k 2 rm -rf /", "timeout --s=KILL 5 rm -rf /",
])
def test_timeout_fails_closed_when_options_do_not_parse(command):
    assert check_command(command).verdict == "block"


def test_timeout_missing_value_leaves_nothing_to_run():
    assert _unwrap(["timeout", "--signal"]) == []


def test_timeout_options_keep_harmless_commands_allowed():
    for command in ("timeout -s KILL 5 ls /tmp/example-dir", "timeout -k 2 5 nohup echo hello", "timeout -- 5 ls"):
        assert check_command(command).verdict == "allow", command
