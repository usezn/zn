"""Lazy exports of zn_gate.integrations: unknown names and dir().

Adapters load on first use, so these checks only read names; they do not need
the framework packages installed.
"""
import re

import pytest

import zn_gate.integrations as integrations


def test_unknown_attribute_raises_attribute_error_naming_the_module():
    with pytest.raises(AttributeError, match=re.escape("module 'zn_gate.integrations' has no attribute 'no_such_adapter'")):
        integrations.no_such_adapter


def test_unknown_attribute_is_reported_missing_by_hasattr():
    assert not hasattr(integrations, "no_such_adapter")


def test_dir_lists_every_public_lazy_name():
    listed = dir(integrations)
    for name in integrations.__all__:
        assert name in listed


def test_dir_is_sorted_and_has_no_duplicates_before_and_after_first_use():
    before = dir(integrations)
    assert "call_api" in before
    assert before == sorted(set(before))

    _ = integrations.call_api  # loads the adapter and caches it in the package namespace

    after = dir(integrations)
    assert "call_api" in after
    assert after == sorted(set(after))
    # Loading an adapter also sets its submodule as an attribute, so the new list may only add names.
    assert set(before) <= set(after)
