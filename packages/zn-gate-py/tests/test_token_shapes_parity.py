"""The Python secret rules give the same secret type as the Node.js ones on the same fake token shapes.

packages/zn-gate/test/fixtures/token_shapes.json holds about fifty texts (GitHub, AWS, Slack, Stripe test
keys, JWT, private keys and near misses), each with the secret type it must give or "none"; the Node.js side
reads the same file in test/token_shapes_parity.test.js. Values are built from segments and are never real
credentials. Skipped when the monorepo fixtures are missing (for example when testing an sdist).
"""

import json
from pathlib import Path

import pytest

from zn_gate.rules import redact_secrets

FIXTURE = Path(__file__).resolve().parents[2] / "zn-gate" / "test" / "fixtures" / "token_shapes.json"

pytestmark = pytest.mark.skipif(not FIXTURE.exists(), reason="needs the monorepo fixtures")

GENERIC = {"env_credential", "prefixed_credential", "credential_default", "credential_assignment", "cli_credential_flag"}
ALIAS = {"AWS_ACCESS_KEY": "AWS_KEY", "AWS_KEY_ID": "AWS_KEY", "JWT_TOKEN": "JWT", "AWS_SECRET_KEY": "AWS_SECRET"}


def _fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _expand(entry, alphabet):
    out = []
    for seg in entry["segments"]:
        if isinstance(seg, str):
            out.append(seg)
        elif "rep" in seg:
            out.append(seg["rep"][0] * seg["rep"][1])
        else:
            n, off = seg["alpha"]
            out.append("".join(alphabet[(off + i) % len(alphabet)] for i in range(n)))
    return "".join(out)


def _entries():
    fx = _fixture()
    return [(e, _expand(e, fx["alphabet"])) for e in fx["entries"]]


def test_fixture_has_the_families_and_the_near_misses():
    entries = _fixture()["entries"]
    assert len(entries) >= 40
    assert len({e["id"] for e in entries}) == len(entries)
    types = {e["expect"] for e in entries}
    assert {"GITHUB_TOKEN", "AWS_KEY", "AWS_SECRET", "SLACK_TOKEN", "STRIPE_KEY", "JWT", "PRIVATE_KEY", "none"} <= types


@pytest.mark.parametrize("entry,text", _entries() if FIXTURE.exists() else [], ids=lambda v: v["id"] if isinstance(v, dict) else "text")
def test_redact_secrets_gives_the_shared_type(entry, text):
    names = {d["rule"].split(":", 1)[1] for d in redact_secrets(text)[1]} - GENERIC
    got = sorted({ALIAS.get(n.upper(), n.upper()) for n in names})
    want = [] if entry["expect"] == "none" else [entry["expect"]]
    assert got == want, entry.get("note", "")
