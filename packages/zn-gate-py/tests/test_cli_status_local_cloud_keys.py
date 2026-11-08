"""`zn-gate status` prints the same lines in local-only and cloud modes, and opens no connection."""
import argparse
import socket

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


@pytest.fixture
def no_network(monkeypatch):
    def refuse(*args, **kwargs):
        raise AssertionError("zn-gate status must not open a network connection")

    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


def _status(capsys):
    assert cli.cmd_status(argparse.Namespace()) == 0
    out = capsys.readouterr().out
    keys = [line.split(":", 1)[0].strip() for line in out.splitlines() if line.startswith("  ") and ":" in line]
    return keys, out


def test_local_only_and_cloud_print_the_same_keys(home, capsys, monkeypatch, no_network):
    monkeypatch.setenv("ZN_API_KEY", FAKE_KEY)
    monkeypatch.setenv("ZN_LOCAL_ONLY", "true")
    local_keys, local_out = _status(capsys)

    monkeypatch.delenv("ZN_LOCAL_ONLY")
    monkeypatch.setenv("ZN_CLOUD", "1")
    monkeypatch.setenv("ZN_API_URL", "https://api.example.invalid/analyze")
    cloud_keys, cloud_out = _status(capsys)

    assert local_keys == cloud_keys
    assert len(local_keys) == len(set(local_keys))
    assert {"Active Engine", "Endpoint", "API key", "Leaves machine"} <= set(local_keys)
    assert "Local rules only" in local_out
    assert "Local rules + cloud" in cloud_out
    assert FAKE_KEY not in local_out and FAKE_KEY not in cloud_out
