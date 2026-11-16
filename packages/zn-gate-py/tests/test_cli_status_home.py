"""`zn-gate status` in a temporary HOME: printed lines and exit code."""
import argparse
import os

import pytest

from zn_gate import cli

ZN_VARS = ("ZN_API_KEY", "ZN_CLOUD", "ZN_LOCAL_ONLY", "ZN_API_URL", "ZN_STAGE")
FAKE_KEY = "zn_test_" + "notarealkey_0000"


@pytest.fixture
def home(tmp_path, monkeypatch):
    for name in ZN_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    return tmp_path


def _status(capsys):
    code = cli.cmd_status(argparse.Namespace())
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def _field(out, name):
    for line in out.splitlines():
        if line.strip().startswith(name):
            return line.split(":", 1)[1].strip()
    raise AssertionError(f"no {name!r} line in output:\n{out}")


def test_no_key_and_no_setting(home, capsys):
    code, out, err = _status(capsys)
    assert code == 0 and err == ""
    assert "zn-gate Status (Python):" in out
    assert _field(out, "API key") == "Not set"
    assert _field(out, "Active Engine") == "Local rules only"
    assert _field(out, "Endpoint").startswith("None")
    assert _field(out, "Leaves machine") == "Nothing"
    assert os.listdir(home) == []


def test_local_only_set_overrides_cloud(home, capsys, monkeypatch):
    monkeypatch.setenv("ZN_LOCAL_ONLY", "true")
    code, out, _ = _status(capsys)
    assert code == 0
    assert _field(out, "API key") == "Not set"
    assert _field(out, "Active Engine") == "Local rules only"
    assert _field(out, "Leaves machine") == "Nothing"


def test_local_only_wins_over_key_and_cloud_opt_in(home, capsys, monkeypatch):
    monkeypatch.setenv("ZN_LOCAL_ONLY", "true")
    monkeypatch.setenv("ZN_CLOUD", "1")
    monkeypatch.setenv("ZN_API_KEY", FAKE_KEY)
    code, out, _ = _status(capsys)
    assert code == 0
    assert _field(out, "API key").startswith("Set (unused")
    assert _field(out, "Active Engine") == "Local rules only"
    assert _field(out, "Endpoint").startswith("None")
    assert FAKE_KEY not in out


def test_key_in_environment_and_stored_marker(home, capsys, monkeypatch):
    (home / ".zn").mkdir()
    (home / ".zn" / "setup-done").write_text("1\n", encoding="utf-8")
    monkeypatch.setenv("ZN_API_KEY", FAKE_KEY)
    code, out, err = _status(capsys)
    assert code == 0 and err == ""
    # A key alone does not turn the cloud on, and the marker changes nothing.
    assert _field(out, "API key") == "Set (unused: cloud requires ZN_CLOUD=1)"
    assert _field(out, "Active Engine") == "Local rules only"
    assert _field(out, "Leaves machine") == "Nothing"
    assert FAKE_KEY not in out
    assert sorted(p.name for p in (home / ".zn").iterdir()) == ["setup-done"]


def test_key_and_cloud_opt_in(home, capsys, monkeypatch):
    monkeypatch.setenv("ZN_API_KEY", FAKE_KEY)
    monkeypatch.setenv("ZN_CLOUD", "1")
    monkeypatch.setenv("ZN_API_URL", "https://api.example.invalid/analyze")
    code, out, _ = _status(capsys)
    assert code == 0
    assert _field(out, "API key") == "Set"
    assert _field(out, "Endpoint") == "https://api.example.invalid/analyze"
    assert "ZN_CLOUD=1" in _field(out, "Active Engine")
    assert FAKE_KEY not in out
