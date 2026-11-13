"""A disk device or a shell startup file written with repeated slashes or "." and ".." segments names the same file,
so it gets the same verdict as the plain spelling. The cases are shared with the npm package
(packages/zn-gate/test/fixtures/path_spelling_cases.json). Only the text is checked: nothing is run."""
import json
from pathlib import Path

import pytest

from zn_gate.destructive import check_command

FIXTURE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "path_spelling_cases.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


def rule(cmd):
    r = check_command(cmd)
    return str(r.rule).replace("destructive:", "") if r.verdict == "block" else "allow"


def test_fixture_is_not_empty():
    assert len(CASES) >= 20


@pytest.mark.parametrize("case", CASES, ids=[c["cmd"] for c in CASES])
def test_shared_path_spelling_case(case):
    assert rule(case["cmd"]) == case["rule"]
