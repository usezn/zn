#!/usr/bin/env python3
"""Checks the file list of the zn-gate Python wheel and sdist.

Usage: python -I .github/scripts/check-python-pack.py <file.whl | file.tar.gz> [...]

Reads the archives without extracting or executing anything. Fails when:
  - a file is outside the allowlist of package paths (see WHEEL_ALLOWED / SDIST_ALLOWED);
  - the archive holds an env file, a key or a certificate;
  - a file is larger than 200 KB;
  - the sdist contains the test suite (tests/ is not shipped; use the git tag to run it).
"""
import re
import sys
import tarfile
import zipfile

MAX_BYTES = 200 * 1024

# Paths relative to the top of the wheel.
WHEEL_ALLOWED = [
    r"zn_gate/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+\.pyi?",
    r"zn_gate/py\.typed",
    r"zn_gate-[^/]+\.dist-info/(?:METADATA|WHEEL|RECORD|entry_points\.txt|top_level\.txt)",
    r"zn_gate-[^/]+\.dist-info/licenses/LICENSE",
]

# Paths relative to the top directory of the sdist (zn_gate-<version>/).
SDIST_ALLOWED = [
    r"PKG-INFO",
    r"LICENSE",
    r"README\.md",
    r"pyproject\.toml",
    r"setup\.cfg",
    r"MANIFEST\.in",
    r"src/zn_gate/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+\.pyi?",
    r"src/zn_gate/py\.typed",
    r"src/zn_gate\.egg-info/(?:PKG-INFO|SOURCES\.txt|dependency_links\.txt|entry_points\.txt|requires\.txt|top_level\.txt)",
]

FORBIDDEN = [
    (re.compile(r"(^|/)\.env(\.|$)"), "env file"),
    (re.compile(r"\.(pem|key|p12|pfx|crt|cer)$", re.I), "key or certificate"),
    (re.compile(r"(^|/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$"), "SSH key"),
    (re.compile(r"(^|/)\.(npmrc|pypirc|netrc)$"), "credentials file"),
]


def entries(path):
    """Return (name, size) for every regular file, plus the sdist top directory (or None)."""
    if path.endswith(".whl"):
        with zipfile.ZipFile(path) as z:
            return [(i.filename, i.file_size) for i in z.infolist() if not i.is_dir()], None
    if path.endswith(".tar.gz"):
        with tarfile.open(path, "r:gz") as t:
            members = t.getmembers()
        names = [m.name for m in members]
        top = names[0].split("/")[0] if names else ""
        return [(m.name, m.size) for m in members if m.isfile()], top
    raise SystemExit(f"error: {path}: expected a .whl or .tar.gz file")


def check(path):
    errors = []
    files, top = entries(path)
    sdist = top is not None
    allowed = [re.compile(p + r"\Z") for p in (SDIST_ALLOWED if sdist else WHEEL_ALLOWED)]
    for name, size in files:
        if name.startswith("/") or ".." in name.split("/"):
            errors.append(f"unsafe path: {name}")
            continue
        rel = name
        if sdist:
            if not name.startswith(top + "/"):
                errors.append(f"file outside the top directory {top}/: {name}")
                continue
            rel = name[len(top) + 1:]
            if rel.startswith("tests/") or "/tests/" in rel:
                errors.append(f"test suite in the sdist: {name}")
                continue
        for rx, what in FORBIDDEN:
            if rx.search(rel):
                errors.append(f"unexpected {what}: {name}")
        if size > MAX_BYTES:
            errors.append(f"file over {MAX_BYTES // 1024} KB ({size} bytes): {name}")
        if not any(rx.match(rel) for rx in allowed):
            errors.append(f"file not in the allowlist: {name}")
    total = sum(s for _, s in files)
    print(f"{path.rsplit('/', 1)[-1]}: {len(files)} files, {total} bytes unpacked")
    return errors


def main(argv):
    if not argv:
        print("usage: check-python-pack.py <file.whl | file.tar.gz> [...]", file=sys.stderr)
        return 2
    failed = False
    for path in argv:
        errors = check(path)
        for e in errors:
            print(f"error: {e}", file=sys.stderr)
        failed = failed or bool(errors)
    if failed:
        return 1
    print("Python package contents OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
