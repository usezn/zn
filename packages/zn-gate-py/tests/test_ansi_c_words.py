"""ANSI-C quoted words ($'...') are decoded the way bash does, in the command head, in arguments and in redirection
targets, and the decoded text is read against every destructive rule. Only text is checked; nothing is run.
Mirrored by packages/zn-gate/test/destructive_ansi_c_words.test.js (same cases, same verdicts)."""
import pytest

from zn_gate import check_command

BLOCKED = [
    ("dd if=/dev/zero of=$'/dev/sdz'", "disk_overwrite"),
    ("chmod -R 777 $'/'", "perm_root"),
    ("$'dd' if=/dev/zero of=/dev/sdz", "disk_overwrite"),
    ("$'rm' -rf $'/'", "rm_root_home"),
    ("chmod -R 777 $'\\x2f'", "perm_root"),
    ("chmod -R 777 $'\\x2F'", "perm_root"),
    ("chmod -R 777 $'\\057'", "perm_root"),
    ("chmod -R 777 $'\\u002f'", "perm_root"),
    ("chmod -R 777 $'\\U0000002f'", "perm_root"),
    ("chmod -R 777 $'/\\x00ignored'", "perm_root"),
    ("chmod -R 777 $'\\x2F'$'\\x2F'", "perm_root"),
    ("dd if=/dev/zero of=$'\\x2fdev/sdz'", "disk_overwrite"),
    ("dd if=/dev/zero of=$'\\x2f\\x64\\x65\\x76/sdz'", "disk_overwrite"),
    ("dd if=/dev/zero of=$'\\U0000002fdev/sdz'", "disk_overwrite"),
    ('dd if=/dev/zero of=$\'/dev/sd\'"z"', "disk_overwrite"),
    ("dd if=/dev/zero of=$'/dev/sd'$'z'", "disk_overwrite"),
    ("$'\\x64d' if=/dev/zero of=/dev/sdz", "disk_overwrite"),
    ("rm -rf $'\\x2f'", "rm_root_home"),
    ("rm -rf $'\\x7e'", "rm_root_home"),
    ("$'\\x72m' -rf $'\\x7e'", "rm_root_home"),
    ("$'chmod' -R 777 $'\\x2f'", "perm_root"),
    ("$'\\x63hmod' -R 777 $'/'", "perm_root"),
    ('chmod -R 777 $\'/\'""', "perm_root"),
    ("chmod -R 777 $'\\x2f' | cat", "perm_root"),
    ("sudo chmod -R 777 $'/'", "perm_root"),
    ("echo x > $'/dev/sdz'", "disk_overwrite"),
    ("echo x > $'\\x2fdev/sdz'", "disk_overwrite"),
    ("bash -c $'dd if=/dev/zero of=\\x2fdev/sdz'", "disk_overwrite"),
    ("bash -c $'chmod -R 777 \\x2f'", "perm_root"),
]

ALLOWED = [
    "echo $'/tmp/x'",
    "dd if=/dev/zero of=$'./out.img'",
    "dd if=/dev/zero of=$'./disk\\x2eimg'",
    "chmod 644 $'file'",
    "chmod 755 $'./bin'",
    "chmod 777 $'/tmp/x'",
    "echo $'chmod -R 777 /'",
    "echo $'dd if=/dev/zero of=/dev/sdz'",
    "printf '%s\\n' $'dd if=/dev/zero of=/dev/sdz'",
    "echo $'\\x2f'",
    "rm -rf $'./build'",
    "cat $'/etc/hosts'",
    'chmod -R 777 "$\'/\'"',
    'dd if=/dev/zero of="$\'/dev/sdz\'"',
    "chmod -R 777 $'\\\\x2f'",
    # A malformed escape (no hex digit) is kept as bash keeps it: the text is read, not refused.
    "rm -rf $'\\x'",
    "echo $'\\u' $'\\U'",
]


@pytest.mark.parametrize("cmd,rule", BLOCKED)
def test_ansi_c_words_are_read_against_every_rule(cmd, rule):
    res = check_command(cmd)
    assert res.verdict == "block", cmd
    assert res.rule == "destructive:" + rule, cmd


@pytest.mark.parametrize("cmd", ALLOWED)
def test_ansi_c_words_that_only_name_a_risky_word_as_data_are_allowed(cmd):
    assert check_command(cmd).verdict == "allow", cmd
