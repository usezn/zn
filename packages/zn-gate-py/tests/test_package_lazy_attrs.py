"""Lazy attribute access on the zn_gate package: dir(), unknown names, repeated access."""

import os
import subprocess
import sys

import pytest

import zn_gate


def _run(code: str) -> str:
    env = dict(os.environ, PYTHONPATH=os.pathsep.join(p for p in sys.path if p))
    proc = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True, env=env)
    return proc.stdout.strip()


def test_every_public_name_is_listed_by_dir():
    listed = dir(zn_gate)
    assert [name for name in zn_gate.__all__ if name not in listed] == []


def test_dir_lists_lazy_names_before_first_access():
    code = (
        "import sys, zn_gate\n"
        "assert 'zn_gate.client' not in sys.modules\n"
        "assert 'analyze' in dir(zn_gate) and 'is_cloud_enabled' in dir(zn_gate)\n"
        "assert 'zn_gate.client' not in sys.modules\n"
        "print('ok')"
    )
    assert _run(code) == "ok"


def test_dir_is_sorted_without_duplicates():
    listed = dir(zn_gate)
    assert listed == sorted(set(listed))


def test_every_public_name_resolves():
    for name in zn_gate.__all__:
        assert getattr(zn_gate, name) is not None or name


def test_unknown_name_raises_attribute_error_with_the_name():
    with pytest.raises(AttributeError) as info:
        zn_gate.no_such_name_example  # noqa: B018
    assert "no_such_name_example" in str(info.value)


def test_unknown_name_is_not_cached_and_hasattr_is_false():
    assert not hasattr(zn_gate, "no_such_name_example")
    assert "no_such_name_example" not in dir(zn_gate)


def test_second_access_returns_the_same_object():
    for name in zn_gate.__all__:
        assert getattr(zn_gate, name) is getattr(zn_gate, name)


def test_lazy_name_is_the_object_from_its_submodule():
    from zn_gate import client

    assert zn_gate.analyze is client.analyze
    assert zn_gate.analyze is zn_gate.analyze
