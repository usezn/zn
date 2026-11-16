"""Ensure tests import the repo's zn_gate, not any installed copy."""
import pytest
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))


@pytest.fixture(autouse=True)
def _node_tools_present(monkeypatch):
    """The npx form of a next step is the default here, so existing expectations hold
    on machines without Node.js. Tests of the no-Node text switch the check off themselves."""
    monkeypatch.setattr("zn_gate.cli.node_available", lambda: True)
    monkeypatch.setattr("zn_gate.mcp_secrets.node_available", lambda: True)
