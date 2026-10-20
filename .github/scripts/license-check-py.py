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


def escape_command_data(value):
    """Escape a value for the message of a GitHub workflow command, so a package
    name or license cannot end the line or start another command."""
    return str(value).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def cell(value):
    """One line for a table cell: a line break would let a value start a workflow command."""
    return " ".join(str(value).split())


def load_allowed(path):
    with open(path, encoding="utf-8") as fh:
        return {line.strip() for line in fh if line.strip() and not line.lstrip().startswith("#")}


def is_allowed(expr, allowed):
    parts = re.split(r"\s*(?:;|\sOR\s)\s*", expr.strip("() "))
    return any(NAMES.get(p, p) in allowed for p in parts)


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
        lines.append(f"| {cell(r['Name'])} | {cell(r['Version'])} | {cell(r['License'])} | {status} |")
    out = "\n".join(lines) + "\n"
    print(out)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as fh:
            fh.write(out)
    for r in findings:
        message = f"{r['Name']}=={r['Version']} is {r['License']}"
        print(f"::warning title=License outside the allowlist::{escape_command_data(message)}")


main()
