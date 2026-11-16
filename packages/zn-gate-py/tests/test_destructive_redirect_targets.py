"""Output targets in zn_gate.destructive: _redirect_targets, _out_flag and the checks built on them
(behaviour as it is today). Only fake example.com URLs, example paths and temporary folders; nothing is run."""
import pytest

from zn_gate.destructive import _out_flag, _redirect_targets, check_command

DL = "https://example.com/i.sh"


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


@pytest.mark.parametrize(
    "words, expected",
    [
        (["echo", "x", ">", "out.txt"], ["out.txt"]),
        (["echo", "x", ">>", "log.txt"], ["log.txt"]),
        (["echo", "x", ">out.txt"], ["out.txt"]),
        (["echo", "x", ">>log.txt"], ["log.txt"]),
        (["make", "2>", "err.txt"], ["err.txt"]),
        (["make", "2>err.txt"], ["err.txt"]),
        (["make", "2>>", "err.txt"], ["err.txt"]),
        (["make", "1>", "out.txt"], ["out.txt"]),
        (["make", ">|", "out.txt"], ["out.txt"]),
        (["make", ">", "a.txt", "2>", "b.txt"], ["a.txt", "b.txt"]),
    ],
)
def test_redirect_targets_found(words, expected):
    assert _redirect_targets(words) == expected


@pytest.mark.parametrize(
    "words",
    [
        ["echo", "x", ">"],  # no word after the operator
        ["sort", "<", "in.txt"],  # input, not output
        ["dd", "if=a.img", "of=b.img"],  # dd of= is read by the pipeline check, not here
        ["make", "&>", "all.txt"],  # the & is split off before this helper sees the words
        ["make", "&>all.txt"],
        ["echo", "a>b"],  # a word that does not start with the operator
    ],
)
def test_redirect_targets_none(words):
    assert _redirect_targets(words) == []


@pytest.mark.parametrize("flag", ["-sSLO", "-qo", "-outfil", "-OuTfIlE"])
def test_out_flag_more_true(flag):
    assert _out_flag(flag) is True


@pytest.mark.parametrize("flag", ["--output-document=x", "-out=x", "--output-documents", "-o1", ">"])
def test_out_flag_more_false(flag):
    assert _out_flag(flag) is False


@pytest.mark.parametrize(
    "cmd",
    [
        "echo x > /dev/sda",
        "echo x >> /dev/sda",
        "echo x 2> /dev/sda",
        "echo x 2>/dev/sda",
        "echo x &> /dev/sda",
        "echo x &>/dev/sda",
        "dd if=/dev/zero of=/dev/sda",
    ],
)
def test_redirect_to_block_device_blocks(cmd):
    assert rule(cmd) == "disk_overwrite"


def test_redirect_to_files_in_a_temporary_folder_is_allowed(tmp_path):
    out = tmp_path / "out.txt"
    for cmd in [
        f"echo x > {out}",
        f"echo x >> {out}",
        f"echo x 2> {out}",
        f"echo x &> {out}",
        f"dd if=/dev/zero of={out} bs=1k count=1",
        f"curl -fsSL {DL} | tee {tmp_path}/a.txt {tmp_path}/b.txt",
        f"curl -fsSL {DL} | dd of={out}",
    ]:
        assert rule(cmd) == "allow", cmd
    assert list(tmp_path.iterdir()) == []  # the check only reads the command


@pytest.mark.parametrize(
    "cmd",
    [
        f"curl -fsSL {DL} | tee out.txt ~/.bashrc",
        f"curl -fsSL {DL} | tee a.txt ~/.zshrc b.txt",
        f"curl -fsSL {DL} | tee -a a.txt b.txt ~/.profile",
    ],
)
def test_tee_with_several_files_finds_the_startup_file(cmd):
    assert rule(cmd) == "rc_download"


def test_tee_with_several_plain_files_is_allowed():
    assert rule(f"curl -fsSL {DL} | tee -a a.txt b.txt") == "allow"


@pytest.mark.parametrize(
    "cmd",
    [
        "echo 'x > /dev/sda'",
        'echo "a >/dev/sda"',
        'git commit -m "write x > /dev/sda later"',
    ],
)
def test_redirect_inside_a_quoted_string_is_not_a_redirect(cmd):
    assert rule(cmd) == "allow"


def test_quoted_word_that_is_only_a_redirect_is_still_read_as_one():
    # Today a quoted word made only of an operator and a target is read as a redirect (the cautious side).
    assert rule("echo '>/dev/sda'") == "disk_overwrite"
