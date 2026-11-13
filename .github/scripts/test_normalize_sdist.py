"""Tests for normalize-sdist.py. Run: python -m pytest .github/scripts/test_normalize_sdist.py

Each test builds a small sdist (.tar.gz) in a temp directory, runs the real script with
SOURCE_DATE_EPOCH set, and checks the archive that comes out.
"""
import gzip
import io
import os
import subprocess
import sys
import tarfile
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "normalize-sdist.py"
EPOCH = 1_700_000_000
LONG_NAME = "pkg-1.0/" + "long_" * 30 + "dir/deep.txt"  # longer than the 100-byte ustar name field
UNICODE_NAME = "pkg-1.0/ñandú.txt"


def run_script(args, epoch=str(EPOCH)):
    env = {k: v for k, v in os.environ.items() if k != "SOURCE_DATE_EPOCH"}
    if epoch is not None:
        env["SOURCE_DATE_EPOCH"] = epoch
    return subprocess.run(
        [sys.executable, "-I", str(SCRIPT), *map(str, args)],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def add(tar, name, data=b"", kind="file", mode=0o644, mtime=1_600_000_000, uid=1000, gid=1000,
        uname="builder", gname="staff", linkname=""):
    info = tarfile.TarInfo(name)
    info.mode = mode
    info.mtime = mtime
    info.uid = uid
    info.gid = gid
    info.uname = uname
    info.gname = gname
    if kind == "dir":
        info.type = tarfile.DIRTYPE
        tar.addfile(info)
    elif kind == "link":
        info.type = tarfile.SYMTYPE
        info.linkname = linkname
        tar.addfile(info)
    else:
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))


def write_sdist(path, entries):
    # Written with tarfile's default gzip wrapper, so the input carries a gzip timestamp too.
    with tarfile.open(path, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        for entry in entries:
            add(tar, **entry)
    return path


def sample_entries(stamp=1_600_000_000, owner=1000, group_write=False, reverse=False):
    entries = [
        {"name": "pkg-1.0/README.md", "data": b"# readme\n", "mode": 0o664 if group_write else 0o644,
         "mtime": stamp, "uid": owner, "gid": owner},
        {"name": "pkg-1.0/scripts/run.sh", "data": b"#!/bin/sh\necho hi\n", "mode": 0o751,
         "mtime": stamp + 1, "uid": owner, "gid": owner, "uname": "someone", "gname": "other"},
        {"name": "pkg-1.0/PKG-INFO", "data": b"Metadata-Version: 2.1\n", "mode": 0o600,
         "mtime": stamp + 2, "uid": owner, "gid": owner},
        {"name": "pkg-1.0/pkg", "kind": "dir", "mode": 0o775, "mtime": stamp + 3, "uid": owner, "gid": owner},
        {"name": "pkg-1.0/pkg/__init__.py", "data": b"x = 1\n", "mode": 0o664, "mtime": stamp + 4,
         "uid": owner, "gid": owner},
        {"name": LONG_NAME, "data": b"long\n", "mode": 0o644, "mtime": stamp + 5, "uid": owner, "gid": owner},
        {"name": UNICODE_NAME, "data": b"unicode\n", "mode": 0o644, "mtime": stamp + 6,
         "uid": owner, "gid": owner},
        {"name": "pkg-1.0", "kind": "dir", "mode": 0o755, "mtime": stamp + 7, "uid": owner, "gid": owner},
    ]
    return list(reversed(entries)) if reverse else entries


def read_members(path):
    with tarfile.open(path, "r:gz") as tar:
        out = []
        for m in tar.getmembers():
            data = tar.extractfile(m).read() if m.isfile() else None
            out.append((m, data))
        return out


def by_name(members):
    return {m.name: (m, data) for m, data in members}


def test_members_sorted_by_name_and_names_kept(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries(reverse=True))
    before = sorted(e["name"] for e in sample_entries())
    assert run_script([src]).returncode == 0
    names = [m.name for m, _ in read_members(src)]
    assert names == sorted(names)
    assert names == before


def test_timestamps_are_source_date_epoch(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries())
    assert run_script([src]).returncode == 0
    assert {m.mtime for m, _ in read_members(src)} == {EPOCH}


def test_owner_names_and_ids_cleared(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries(owner=501))
    assert run_script([src]).returncode == 0
    for m, _ in read_members(src):
        assert (m.uid, m.gid) == (0, 0), m.name
        assert (m.uname, m.gname) == ("", ""), m.name


def test_modes_are_0755_for_folders_and_executables_0644_otherwise(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries(group_write=True))
    assert run_script([src]).returncode == 0
    modes = {m.name: m.mode & 0o7777 for m, _ in read_members(src)}
    assert modes["pkg-1.0/scripts/run.sh"] == 0o755  # 0751 in the input: execute bit kept
    assert modes["pkg-1.0/PKG-INFO"] == 0o644  # 0600 in the input: normalised up to 0644
    assert modes["pkg-1.0/README.md"] == 0o644  # group-writable 0664 in the input
    assert modes["pkg-1.0/pkg/__init__.py"] == 0o644
    assert modes["pkg-1.0/pkg"] == 0o755
    assert modes["pkg-1.0"] == 0o755


def test_contents_and_entry_types_unchanged(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries())
    assert run_script([src]).returncode == 0
    got = by_name(read_members(src))
    assert got["pkg-1.0/README.md"][1] == b"# readme\n"
    assert got["pkg-1.0/scripts/run.sh"][1] == b"#!/bin/sh\necho hi\n"
    assert got[LONG_NAME][1] == b"long\n"
    assert got[UNICODE_NAME][1] == b"unicode\n"
    assert got["pkg-1.0/pkg"][0].isdir()
    assert got["pkg-1.0"][0].isdir()
    assert got["pkg-1.0/pkg/__init__.py"][0].isfile()


def test_gzip_header_has_no_time_and_no_file_name(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries())
    assert run_script([src]).returncode == 0
    raw = src.read_bytes()
    assert raw[:2] == b"\x1f\x8b"
    assert raw[3] & 0x08 == 0, "FNAME flag set: the header carries a file name"
    assert raw[4:8] == b"\x00\x00\x00\x00", "MTIME field is not zero"
    # The payload is still a valid tar.
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(raw))) as tar:
        assert tar.getnames()


def test_same_content_different_build_gives_identical_bytes(tmp_path):
    # Two builds of the same files: other timestamps, owners, insertion order and group write bit.
    a = write_sdist(tmp_path / "a.tar.gz", sample_entries(stamp=1_600_000_000, owner=1000))
    b = write_sdist(tmp_path / "b.tar.gz",
                    sample_entries(stamp=1_650_000_000, owner=0, group_write=True, reverse=True))
    assert a.read_bytes() != b.read_bytes()
    assert run_script([a]).returncode == 0
    assert run_script([b]).returncode == 0
    assert a.read_bytes() == b.read_bytes()


def test_normalising_twice_is_a_no_op(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries())
    assert run_script([src]).returncode == 0
    first = src.read_bytes()
    assert run_script([src]).returncode == 0
    assert src.read_bytes() == first


def test_several_archives_in_one_call(tmp_path):
    a = write_sdist(tmp_path / "a-1.0.tar.gz", sample_entries(stamp=1_600_000_000))
    b = write_sdist(tmp_path / "b-1.0.tar.gz", sample_entries(stamp=1_660_000_000))
    assert run_script([a, b]).returncode == 0
    assert {m.mtime for m, _ in read_members(a)} == {EPOCH}
    assert {m.mtime for m, _ in read_members(b)} == {EPOCH}
    assert not (tmp_path / "a-1.0.tar.gz.tmp").exists()


def test_symlink_member_is_refused_and_archive_left_alone(tmp_path):
    entries = sample_entries() + [{"name": "pkg-1.0/link", "kind": "link", "linkname": "README.md"}]
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", entries)
    before = src.read_bytes()
    result = run_script([src])
    assert result.returncode != 0
    assert "unexpected member type: pkg-1.0/link" in result.stderr
    assert src.read_bytes() == before
    assert not (tmp_path / "pkg-1.0.tar.gz.tmp").exists()


def test_source_date_epoch_is_required(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries())
    before = src.read_bytes()
    result = run_script([src], epoch=None)
    assert result.returncode == 2
    assert "SOURCE_DATE_EPOCH must be set" in result.stderr
    assert src.read_bytes() == before


def test_source_date_epoch_must_be_digits(tmp_path):
    src = write_sdist(tmp_path / "pkg-1.0.tar.gz", sample_entries())
    before = src.read_bytes()
    for bad in ("", "1700000000.5", "-1", "17e8"):
        result = run_script([src], epoch=bad)
        assert result.returncode == 2, bad
        assert src.read_bytes() == before


def test_no_arguments_prints_usage(tmp_path):
    result = run_script([], epoch=str(EPOCH))
    assert result.returncode == 2
    assert "Usage: normalize-sdist.py <sdist.tar.gz>" in result.stderr
