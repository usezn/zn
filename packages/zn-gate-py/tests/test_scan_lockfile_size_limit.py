"""`zn-gate scan` and lockfiles: the size limit decides, not the name.

`package-lock.json` has a scanned extension (.json), so it is read below the 2 MiB
limit and listed as skipped at or above it. Lockfiles with an extension the scan does
not read (`poetry.lock`, `yarn.lock`) are not in the scan at all, whatever their size.
The xfail cases document that gap; the scan itself is not changed here.
"""

import argparse
import io
import json
from contextlib import redirect_stdout

import pytest

from zn_gate import cli

LIMIT = cli._MAX_SCAN_BYTES
SMALL = b'{"name": "demo", "lockfileVersion": 3}\n'


def _scan_json(path):
    ns = argparse.Namespace(path=str(path), format="json", no_fail=False,
                            allow_partial=False, include=None, exclude=None)
    buf = io.StringIO()
    with redirect_stdout(buf):
        code = cli.cmd_scan(ns)
    return code, json.loads(buf.getvalue())


def test_package_lock_below_the_limit_is_scanned(tmp_path):
    (tmp_path / "package-lock.json").write_bytes(SMALL)
    code, data = _scan_json(tmp_path)
    assert data["total_files"] == 1
    assert data["skipped"] == []
    assert code == 0


def test_package_lock_one_byte_below_the_limit_is_scanned(tmp_path):
    (tmp_path / "package-lock.json").write_bytes(b"x" * (LIMIT - 1))
    code, data = _scan_json(tmp_path)
    assert data["total_files"] == 1
    assert data["skipped"] == []
    assert code == 0


def test_package_lock_at_the_limit_is_skipped(tmp_path):
    (tmp_path / "package-lock.json").write_bytes(b"x" * LIMIT)
    code, data = _scan_json(tmp_path)
    assert data["total_files"] == 0
    assert data["skipped"] == [{"file": str(tmp_path / "package-lock.json"), "reason": "2 MiB or larger"}]
    assert code == 3


def test_package_lock_above_the_limit_is_skipped(tmp_path):
    (tmp_path / "package-lock.json").write_bytes(b"x" * (LIMIT + 1))
    code, data = _scan_json(tmp_path)
    assert data["total_files"] == 0
    assert data["skipped"] == [{"file": str(tmp_path / "package-lock.json"), "reason": "2 MiB or larger"}]
    assert code == 3


@pytest.mark.xfail(strict=True, reason="cmd_scan reads only extensions in valid_exts; .lock is not one, "
                                       "so poetry.lock and yarn.lock are never scanned")
@pytest.mark.parametrize("name", ["poetry.lock", "yarn.lock"])
def test_other_lockfile_below_the_limit_is_scanned(tmp_path, name):
    (tmp_path / name).write_bytes(SMALL)
    _, data = _scan_json(tmp_path)
    assert data["total_files"] == 1


@pytest.mark.xfail(strict=True, reason="cmd_scan reads only extensions in valid_exts; .lock is not one, "
                                       "so poetry.lock and yarn.lock are never listed as skipped by size")
@pytest.mark.parametrize("name", ["poetry.lock", "yarn.lock"])
def test_other_lockfile_above_the_limit_is_listed_as_skipped(tmp_path, name):
    (tmp_path / name).write_bytes(b"x" * LIMIT)
    _, data = _scan_json(tmp_path)
    assert data["skipped"] == [{"file": str(tmp_path / name), "reason": "2 MiB or larger"}]
