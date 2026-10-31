"""Compare the licenses of the Python package and its dependencies with the
SPDX allowlist. Informational: it always exits 0.

Reads the JSON that `pip-licenses --from=mixed --format=json` printed.
Usage: python license-check-py.py <pip-licenses.json> <allowlist file>
"""
import json
import os
import re
import sys

# pip-licenses can print a classifier name instead of an SPDX id.
NAMES = {
    "MIT License": "MIT",
    "BSD License": "BSD-3-Clause",
    "Apache Software License": "Apache-2.0",
    "ISC License (ISCL)": "ISC",
}

# Operators: "AND" binds tighter than "OR"; ";" is how pip-licenses separates
# several licenses, and it counts as "OR". Parentheses group.
TOKEN = re.compile(r"\(|\)|;|\bAND\b|\bOR\b|[^\s();]+")


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
    if pos >= len(tokens) or tokens[pos] in ("AND", "OR", ";", ")"):
        raise ValueError("expected a license id")
    if tokens[pos] == "(":
        value, pos = parse_or(tokens, pos + 1, allowed)
        if pos >= len(tokens) or tokens[pos] != ")":
            raise ValueError("missing )")
        return value, pos + 1
    return tokens[pos] in allowed, pos + 1


def is_allowed(expr, allowed):
    # Map classifier names first: some contain parentheses of their own.
    text = expr.strip()
    for name, spdx in sorted(NAMES.items(), key=lambda kv: -len(kv[0])):
        text = text.replace(name, spdx)
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
