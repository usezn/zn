"""env -S / --split-string takes a command line. check_command reads it as a nested command, and refuses it when the
nesting is deeper than the checker follows. Mirrors packages/zn-gate/test/destructive_env_split_string.test.js. Only the
text is checked; nothing is run."""
import json

from zn_gate.destructive import check_command


def nest(cmd, n):
    s = cmd
    for _ in range(n):
        s = "env -S " + json.dumps(s)
    return s


def test_env_split_string_variants_blocked():
    for c in [
        'env -S "rm -rf /"',
        'env --split-string="rm -rf /"',
        'env --split-string "rm -rf /"',
        'env -S "dd of=/dev/sda if=/dev/zero"',
    ]:
        assert check_command(c).verdict == "block", c


def test_benign_env_split_string_allowed():
    for c in ['env -S "echo hello"', 'env --split-string="echo hello"', nest("echo hello", 2)]:
        assert check_command(c).verdict == "allow", c


def test_nested_env_split_string_blocked_at_every_depth():
    for n in range(1, 9):
        assert check_command(nest("rm -rf /", n)).verdict == "block", n
