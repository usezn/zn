"""The shared corpus of keys on adjacent lines, wrapped across lines, or both
(packages/zn-gate/test/fixtures/adjacent_secrets_cases.json, made by test/helpers/make_adjacent_secret_cases.js).
The Node.js package runs the same file in test/scrub_adjacent_secrets_cases.test.js, so both engines report the
same rules and leave no part of a key readable. Every key is fictitious. The test needs the monorepo checkout and
is skipped when the corpus is missing (for example when testing an sdist)."""
import json
from pathlib import Path

import pytest

from zn_gate.rules import redact_secrets

CORPUS = Path(__file__).resolve().parents[2] / 'zn-gate' / 'test' / 'fixtures' / 'adjacent_secrets_cases.json'
pytestmark = pytest.mark.skipif(not CORPUS.exists(), reason='the monorepo corpus is not next to this package')


def _readable_fragment(out, keys):
    """Any 8 characters in a row of a key that are still in the output."""
    for key in keys:
        for i in range(len(key) - 7):
            if key[i:i + 8] in out:
                return key[i:i + 8]
    return None


def _cases():
    return json.loads(CORPUS.read_text(encoding='utf-8'))


def test_corpus_is_not_empty():
    cases = _cases()
    assert len(cases) > 400
    assert all(c['id'] and c['text'] and c['keys'] and isinstance(c['rules'], list) for c in cases)


def test_adjacent_and_wrapped_keys_one_detection_per_key_and_nothing_readable():
    failures = []
    for c in _cases():
        out, found = redact_secrets(c['text'])
        rules = sorted(d['rule'] for d in found)
        left = _readable_fragment(out, c['keys'])
        lost = [k for k in c['keep'] if k not in out]
        if left or lost or rules != c['rules']:
            failures.append(f"{c['id']}: rules {rules} want {c['rules']}" + (f', readable {left}' if left else '') + (f', lost {lost}' if lost else ''))
    assert failures == []
