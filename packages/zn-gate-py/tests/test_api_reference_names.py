"""Every public name of the Python package (zn_gate.__all__ and zn_gate.integrations.__all__)
is documented in docs/api-reference.md, in the Python part of the page, either as a heading
or as a backticked mention (constants, types, the version and aliases are mentioned). Headings
for names that are no longer exported are reported as stale."""
import re
from pathlib import Path

import pytest

import zn_gate
import zn_gate.integrations

REPO = Path(__file__).resolve().parents[3]
DOC = REPO / "docs" / "api-reference.md"

pytestmark = pytest.mark.skipif(not DOC.exists(), reason="repository docs not in this checkout")


def _python_part() -> str:
    text = DOC.read_text(encoding="utf-8")
    start = text.index("\n## Python")
    return text[start:]


def _headings(part: str) -> set:
    return {m.group(1) for m in re.finditer(r"^### `@?([A-Za-z_][A-Za-z0-9_]*)", part, re.M)}


def _mentioned(part: str, name: str) -> bool:
    return re.search(r"`@?" + re.escape(name) + r"[`(\[\s,.:;)]", part) is not None


PUBLIC_NAMES = sorted(set(zn_gate.__all__) | set(zn_gate.integrations.__all__))


def test_public_names_are_listed_in_the_package_exports():
    # Sanity: the lists are real, so the checks below cannot pass on an empty set.
    assert len(zn_gate.__all__) >= 20
    assert len(zn_gate.integrations.__all__) >= 9


@pytest.mark.parametrize("name", PUBLIC_NAMES)
def test_public_name_is_documented(name):
    part = _python_part()
    assert _mentioned(part, name), f"{name} is in __all__ but not in the Python part of docs/api-reference.md"


def test_every_documented_heading_is_a_public_name():
    # The reverse direction: a heading for a name that is no longer exported is stale.
    headings = _headings(_python_part())
    exported = set(PUBLIC_NAMES)
    stale = sorted(h for h in headings if h not in exported)
    assert not stale, f"headings for names not in __all__: {stale}"
