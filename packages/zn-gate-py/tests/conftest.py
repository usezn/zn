"""Ensure tests import the repo's zn_gate, not any installed copy."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))

import pytest


@pytest.fixture(autouse=True)
def _reset_client_warnings():
    """The client warns once per process; each test starts with no warning given."""
    from zn_gate import client
    getattr(client, "_WARNED", set()).clear()
    yield
