"""env -S "STRING" splits STRING into words, and env reads those words again as options and a command, so a string that
itself holds an -S option (env -S "-S rm -rf DIR", env -S "env -S 'rm -rf DIR'") is split a second time. The check reads
such strings again the same way, up to three levels deep, and refuses a deeper one. The words after an -S value belong to
the command the string names, even when env took them for options (env -S "rm" -rf DIR). Mirrors
packages/zn-gate/test/destructive_nested_env_split.test.js. Only the text is checked; nothing is run."""
from zn_gate.destructive import check_command


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


def nest(cmd, levels):
    """The command wrapped in env -S '...' that many times (single quotes inside are closed and reopened)."""
    s = cmd
    for _ in range(levels):
        s = "env -S '" + s.replace("'", "'\\''") + "'"
    return s


BLOCK = [
    'env -S "-S rm -rf /home/alice"',
    'env -S "-S rm" -rf /home/alice',
    'env -S "rm" -rf /home/alice',
    'env -S "-S -S rm -rf /usr"',
    'env -S "-S \'rm -rf\' /home/alice"',
    'env -S "env -S \'rm -rf /home/alice\'"',
    'env -S "-S env -S \'rm -rf /home/alice\'"',
    'env --split-string "-S rm -rf /etc"',
    'env -S "--split-s rm -rf /etc"',
    'sudo env -S "-S rm -rf /usr"',
    'env -S "-i -S rm -rf /home/alice"',
    nest("rm -rf /home/alice", 1),
    nest("rm -rf /home/alice", 2),
    nest("rm -rf /home/alice", 3),
    nest("rm -rf /", 3),
    nest('sh -c "rm -rf /home/alice"', 2),
]

ALLOW = [
    'env -S "-S ls -la"',
    'env -S "-S rm -rf ./build"',
    'env -S "-S rm -f notes.txt"',
    'env -S "-S echo hello"',
    'env -S "rm" -rf ./build',
    'env -S "-S -S ls -la"',
    'env -S "env -S \'ls -la\'"',
    nest("ls -la", 1),
    nest("ls -la", 2),
    nest("ls -la", 3),
    nest("rm -rf ./build", 3),
]

# Four levels are more than the check follows: refused, whatever the command is.
TOO_DEEP = [
    nest("rm -rf /home/alice", 4),
    nest("ls -la", 4),
    nest("echo hello", 5),
]


def test_nested_env_split_strings_that_delete_protected_folders_are_blocked():
    for c in BLOCK:
        assert rule(c) == "rm_root_home", c


def test_nested_env_split_strings_of_harmless_commands_stay_allowed():
    for c in ALLOW:
        assert rule(c) == "allow", c


def test_env_split_strings_nested_deeper_than_three_levels_are_refused():
    for c in TOO_DEEP:
        assert rule(c) == "too_many_commands", c
