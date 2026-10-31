"""Compare the licenses of the Python package and its dependencies with the
SPDX allowlist. Informational: it always exits 0.

Reads the JSON that `pip-licenses --from=mixed --format=json` printed.
Usage: python license-check-py.py <pip-licenses.json> <allowlist file>
"""
import json
import os
import re
import sys

# pip-licenses can print a classifier or a free-text name instead of an SPDX id.
# Keys are compared case-insensitively. Names that map to an id outside the
# allowlist (for example "Python Software Foundation License") stay in the
# table on purpose: the allowlist decides, this table only translates.
NAMES = {
    "MIT License": "MIT",
    "MIT": "MIT",
    "BSD License": "BSD-3-Clause",
    "BSD": "BSD-3-Clause",
    "3-Clause BSD License": "BSD-3-Clause",
    "BSD 3-Clause": "BSD-3-Clause",
    "BSD 3-Clause License": "BSD-3-Clause",
    "BSD-3-Clause License": "BSD-3-Clause",
    "New BSD License": "BSD-3-Clause",
    "2-Clause BSD License": "BSD-2-Clause",
    "BSD 2-Clause": "BSD-2-Clause",
    "BSD 2-Clause License": "BSD-2-Clause",
    "Simplified BSD License": "BSD-2-Clause",
    "Apache Software License": "Apache-2.0",
    "Apache License": "Apache-2.0",
    "Apache 2.0": "Apache-2.0",
    "Apache 2": "Apache-2.0",
    "Apache License 2.0": "Apache-2.0",
    "Apache License Version 2.0": "Apache-2.0",
    "Apache License, Version 2.0": "Apache-2.0",
    "Apache-2.0 License": "Apache-2.0",
    "ISC License (ISCL)": "ISC",
    "ISC License": "ISC",
    "Python Software Foundation License": "PSF-2.0",
    "PSF": "PSF-2.0",
    "PSFL": "PSF-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
}

# "WITH" exceptions that do not change what the project may ship. The base
# license still has to be on the allowlist. Keep this in step with the
# "<id> WITH <exception>" entries of deny.toml (check-license-allowlist.py).
EXCEPTIONS = {"LLVM-exception"}

# Operators: "AND" binds tighter than "OR"; ";" is how pip-licenses separates
# several licenses, and it counts as "OR". "WITH" attaches an exception to the
# id before it. Parentheses group.
TOKEN = re.compile(r"\(|\)|;|AND|OR|WITH|[^\s();]+")
NAME_PATTERNS = [
    (re.compile(r"(?<![\w.-])" + re.escape(name) + r"(?![\w.-])", re.IGNORECASE), spdx)
    for name, spdx in sorted(NAMES.items(), key=lambda kv: -len(kv[0]))
]


def load_allowed(path):
    with open(path, encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip() and not line.lstrip().startswith("#")}


def parse_or(tokens, pos, allowed):
    value, pos = parse_and(tokens, pos, allowed)
    while pos < len(tokens) and tokens[pos] in ("OR", ";"):
        other, pos = parse_and(tokens, pos + 1, allowed)
        value = value or other
    return value, pos


def parse_and(tokens, pos, allowed):
    value, pos = parse_atom(tokens, pos, allowed)
    while pos < len(tokens) and tokens[pos] == "AND":
        other, pos = parse_atom(tokens, pos + 1, allowed)
        value = value and other
    return value, pos


def parse_atom(tokens, pos, allowed):
    if pos >= len(tokens) or tokens[pos] in ("AND", "OR", "WITH", ";", ")"):
        raise ValueError("expected a license id")
    if tokens[pos] == "(":
        value, pos = parse_or(tokens, pos + 1, allowed)
        if pos >= len(tokens) or tokens[pos] != ")":
            raise ValueError("missing )")
        return value, pos + 1
    base = tokens[pos]
    pos += 1
    if pos < len(tokens) and tokens[pos] == "WITH":
        if pos + 1 >= len(tokens) or tokens[pos + 1] in ("AND", "OR", ";", "(", ")", "WITH"):
            raise ValueError("expected an exception id after WITH")
        return base in allowed and tokens[pos + 1] in EXCEPTIONS, pos + 2
    return base in allowed, pos


def is_allowed(expr, allowed):
    # Map classifier and free-text names first: some contain parentheses or
    # commas of their own. Longest names go first, and an id such as
    # "BSD-3-Clause" is never rewritten by the shorter name "BSD".
    text = expr.strip()
    for pattern, spdx in NAME_PATTERNS:
        text = pattern.sub(spdx, text)
    tokens = TOKEN.findall(text)
    try:
        value, pos = parse_or(tokens, 0, allowed)
    except ValueError:
        return False  # anything we cannot read is flagged
    return pos == len(tokens) and value


def main():
    with open(sys.argv[1], encoding="utf-8") as fh:
        rows = json.load(fh)
    allowed = load_allowed(sys.argv[2])
    findings = [r for r in rows if not is_allowed(r["License"], allowed)]
    lines = [
        f"### PyPI package and dependencies: {len(rows)} package(s), {len(findings)} outside the allowlist",
        "",
        "| Package | Version | License | Status |",
        "|---|---|---|---|",
    ]
    for r in rows:
        status = "ok" if is_allowed(r["License"], allowed) else "review"
        lines.append(f"| {r['Name']} | {r['Version']} | {r['License']} | {status} |")
    out = "\n".join(lines) + "\n"
    print(out)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(out)
    for r in findings:
        print(f"::warning title=License outside the allowlist::{r['Name']}=={r['Version']} is {r['License']}")


main()
