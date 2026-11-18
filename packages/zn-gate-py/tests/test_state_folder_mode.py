"""zn's state folder: a loose folder owned by this account is tightened to 0700; one owned by someone else is refused."""
import os
import stat

import pytest

from zn_gate.state_dir import StateDirError, describe, ensure_state_dir

posix = os.name == "posix" and hasattr(os, "getuid")
pytestmark = pytest.mark.skipif(not posix, reason="POSIX modes only")
not_root = pytest.mark.skipif(posix and os.getuid() == 0, reason="needs a non-root account")


def _mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


@pytest.fixture
def home(tmp_path):
    return str(tmp_path)


def test_loose_setgid_and_sticky_folders_are_tightened(home):
    for name, mode in (("a", 0o777), ("b", 0o2777), ("c", 0o1777)):
        d = os.path.join(home, name)
        os.mkdir(d)
        os.chmod(d, mode)
        ensure_state_dir(d)
        assert _mode(d) == 0o700


def test_missing_folder_is_created_private(home):
    d = os.path.join(home, "x", "y")
    ensure_state_dir(d)
    assert _mode(d) == 0o700
    ensure_state_dir(os.path.join(home, "nope"), create=False)
    assert not os.path.exists(os.path.join(home, "nope"))


def test_subfolder_tightens_the_state_folder(home, monkeypatch):
    zn = os.path.join(home, ".zn")
    os.mkdir(zn)
    os.chmod(zn, 0o777)
    monkeypatch.setenv("ZN_HOME", zn)
    ensure_state_dir(os.path.join(zn, "sub"))
    assert _mode(zn) == 0o700


@not_root
def test_folder_owned_by_another_user_is_refused():
    with pytest.raises(StateDirError, match="owned by another user"):
        ensure_state_dir("/usr")


@not_root
def test_evidence_does_not_write_into_a_foreign_folder(capsys):
    from zn_gate import evidence
    rec = evidence.log_evidence({"action": "t"}, file_path="/usr/zn-test/evidence.jsonl")
    assert rec is None
    assert not os.path.exists("/usr/zn-test")


def test_evidence_tightens_a_loose_folder(home):
    from zn_gate import evidence
    zn = os.path.join(home, ".zn")
    os.mkdir(zn)
    os.chmod(zn, 0o777)
    evidence.log_evidence({"action": "t"}, file_path=os.path.join(zn, "evidence.jsonl"))
    assert _mode(zn) == 0o700


def test_describe_reports_the_mode(home):
    d = os.path.join(home, ".zn")
    os.mkdir(d)
    os.chmod(d, 0o777)
    assert any("mode 0777" in s for s in describe(d))
    os.chmod(d, 0o700)
    assert describe(d) == []
    assert describe(os.path.join(home, "absent")) == []
