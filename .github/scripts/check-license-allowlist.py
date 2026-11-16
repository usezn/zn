"""Fail when the license lists of the different checks drift apart.

.github/license-allowlist.txt is the single list of SPDX ids. Two other files carry a
copy because their tools cannot read it:
  - deny.toml, [licenses] allow (cargo-deny): the same ids, plus "<id> WITH <exception>"
    entries whose base id is on the list and whose exception is a known one;
  - .github/workflows/dependency-review.yml, allow-licenses (dependency-review-action):
    exactly the same ids.
Usage: python check-license-allowlist.py [allowlist] [deny.toml] [workflow]
Exit status 0 when they agree, 1 when they differ, 2 when a file cannot be read.
"""
import re
import sys
from pathlib import Path

# Same set as EXCEPTIONS in license-check-py.py and license-check.mjs.
EXCEPTIONS = {"LLVM-exception"}


def read_allowlist(text):
    return {line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")}


def read_deny(text):
    section = re.search(r"^\[licenses\]\s*$(.*?)(?=^\[|\Z)", text, re.MULTILINE | re.DOTALL)
    if not section:
        raise ValueError("no [licenses] section in deny.toml")
    array = re.search(r"^allow\s*=\s*\[(.*?)\]", section.group(1), re.MULTILINE | re.DOTALL)
    if not array:
        raise ValueError("no allow = [...] list in the [licenses] section of deny.toml")
    body = re.sub(r"#[^\n]*", "", array.group(1))
    return set(re.findall(r'"([^"]+)"', body))


def read_workflow(text):
    match = re.search(r"^\s*allow-licenses:\s*(.+?)\s*$", text, re.MULTILINE)
    if not match:
        raise ValueError("no allow-licenses line in the workflow")
    return {part.strip() for part in match.group(1).split(",") if part.strip()}


def problems(allowlist, deny, workflow):
    found = []
    plain = {e for e in deny if " WITH " not in e}
    withs = {e for e in deny if " WITH " in e}
    for entry in sorted(withs):
        base, _, exception = entry.partition(" WITH ")
        if base not in allowlist:
            found.append(f"deny.toml: '{entry}' has a base license that is not on the allowlist")
        if exception not in EXCEPTIONS:
            found.append(f"deny.toml: '{entry}' uses an exception the checkers do not know")
    for label, other in (("deny.toml", plain), ("dependency-review.yml allow-licenses", workflow)):
        for missing in sorted(allowlist - other):
            found.append(f"{label} lacks {missing}, which is on .github/license-allowlist.txt")
        for extra in sorted(other - allowlist):
            found.append(f"{label} has {extra}, which is not on .github/license-allowlist.txt")
    return found


def main(argv):
    root = Path(__file__).resolve().parents[2]
    paths = [Path(a) for a in argv[1:4]] + [None] * (3 - len(argv[1:4]))
    allow_path = paths[0] or root / ".github" / "license-allowlist.txt"
    deny_path = paths[1] or root / "deny.toml"
    workflow_path = paths[2] or root / ".github" / "workflows" / "dependency-review.yml"
    try:
        allowlist = read_allowlist(allow_path.read_text(encoding="utf-8"))
        deny = read_deny(deny_path.read_text(encoding="utf-8"))
        workflow = read_workflow(workflow_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    found = problems(allowlist, deny, workflow)
    for line in found:
        print(f"::error title=License lists differ::{line}")
    if not found:
        print(f"License lists agree: {len(allowlist)} ids in the allowlist, deny.toml and dependency-review.yml.")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
