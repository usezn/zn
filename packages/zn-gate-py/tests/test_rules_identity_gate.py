"""The word gate in front of the two identity-request rules may only skip texts the
pattern cannot match: gated and plain results must agree on every sample."""

import json
import os
import re
import unittest

from zn_gate import rules as R

RULE_IDS = ('pi:identity_request', 'pi:identity_request_multi')
PATTERNS = {rid: pat for rid, pat, _ in R.INJECTION_RULES if rid in RULE_IDS}
FIXTURES = os.path.join(os.path.dirname(__file__), '..', '..', 'zn-gate', 'test', 'fixtures')


def load(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as fh:
        return json.load(fh)


def text_of(item):
    if isinstance(item, str):
        return item
    # Repeated-unit samples ({repeat, times, prefix?, suffix?}) are expanded up to 20000 characters.
    unit = item['repeat']
    return (item.get('prefix') or '') + unit * min(item['times'], 20000 // len(unit)) + (item.get('suffix') or '')


def vocabulary():
    words = set()
    for pat in PATTERNS.values():
        words.update(re.findall(r"[^\W\d_]+(?:[-'][^\W\d_]+)?", pat.pattern))
    return sorted(words)


class IdentityGateTest(unittest.TestCase):
    def assert_same(self, text):
        for rid, pat in PATTERNS.items():
            self.assertEqual(
                bool(R.RULE_TESTERS[rid](text)), pat.search(text) is not None,
                '%s differs on %r' % (rid, text[:120]))

    def test_rules_use_the_gate(self):
        for rid in RULE_IDS:
            self.assertIn(rid, R.RULE_TESTERS)

    def test_fixtures_and_near_misses(self):
        cases = load('identity_request_cases.json')
        texts = [text_of(x) for x in cases['positives'] + cases['benign']]
        texts += [text_of(x) for x in load('rules_parity_samples.json')['samples']]
        self.assertGreater(len(texts), 100)
        for text in texts:
            self.assert_same(text)
            self.assert_same(text.upper())
            if len(text) > 300:
                continue
            words = text.split(' ')
            for i in range(len(words)):
                self.assert_same(' '.join(words[:i] + words[i + 1:]))

    def test_every_pattern_word_in_a_matching_sentence(self):
        positives = [text_of(x) for x in load('identity_request_cases.json')['positives']]
        vocab = vocabulary()
        hits = {rid: 0 for rid in RULE_IDS}
        for text in positives:
            words = text.split(' ')
            for i in range(len(words)):
                for word in vocab:
                    sample = ' '.join(words[:i] + [word] + words[i + 1:])
                    for rid, pat in PATTERNS.items():
                        expected = pat.search(sample) is not None
                        hits[rid] += expected
                        self.assertEqual(bool(R.RULE_TESTERS[rid](sample)), expected, '%s %r' % (rid, sample[:120]))
        for rid in RULE_IDS:
            self.assertGreater(hits[rid], 1000, rid)


if __name__ == '__main__':
    unittest.main()
