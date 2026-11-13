"""Ensure tests import the repo's zn_gate, not any installed copy."""
import pytest
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))


def pytest_collection_modifyitems(config, items):
    """Fast path for local runs: ZN_SKIP_SLOW=1 skips the tests marked slow.

    The same as -m "not slow". CI runs everything, so a run that has CI set refuses the variable
    instead of silently dropping tests.
    """
    if os.environ.get('ZN_SKIP_SLOW', '') in ('', '0'):
        return
    if os.environ.get('CI'):
        raise pytest.UsageError('ZN_SKIP_SLOW must not be set in CI: every test has to run there.')
    skip = pytest.mark.skip(reason='slow test skipped by ZN_SKIP_SLOW')
    for item in items:
        if 'slow' in item.keywords:
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def _node_tools_present(monkeypatch):
    """The npx form of a next step is the default here, so existing expectations hold
    on machines without Node.js. Tests of the no-Node text switch the check off themselves."""
    monkeypatch.setattr("zn_gate.cli.node_available", lambda: True)
    monkeypatch.setattr("zn_gate.mcp_secrets.node_available", lambda: True)
