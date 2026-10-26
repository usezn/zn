import importlib

import pytest

import zn_gate

NAMES = list(zn_gate.__all__)


def test_all_is_not_empty_and_unique():
    assert NAMES
    assert len(NAMES) == len(set(NAMES))


@pytest.mark.parametrize("name", NAMES)
def test_all_name_is_importable(name):
    module = importlib.import_module("zn_gate")
    assert getattr(module, name) is not None


@pytest.mark.parametrize("name", NAMES)
def test_all_name_is_in_dir(name):
    assert name in dir(zn_gate)


def test_star_import_exposes_all_names():
    scope = {}
    exec("from zn_gate import *", scope)
    for name in NAMES:
        assert name in scope
