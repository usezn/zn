"""Parity with the Rust and Node.js engines: all read the same cases
(packages/zn-gate/test/fixtures/credentials_request_cases.json) and must give the
same answer for the exfil:credentials rule."""
import json
import unittest
from pathlib import Path

from zn_gate import rules as R

FIXTURE = Path(__file__).resolve().parents[2] / 'zn-gate' / 'test' / 'fixtures' / 'credentials_request_cases.json'


def matches(text):
    return bool(R.EXFIL_VERBS.search(text) and R.CRED_OBJECTS.search(text) and R.EXFIL_CLAUSE_RE.search(text))


class TestCredentialsRequestCases(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads(FIXTURE.read_text(encoding='utf-8'))

    def test_requests_match(self):
        self.assertTrue(self.cases['block'])
        for text in self.cases['block']:
            with self.subTest(text=text):
                self.assertTrue(matches(text))

    def test_descriptions_do_not_match(self):
        self.assertTrue(self.cases['allow'])
        for text in self.cases['allow']:
            with self.subTest(text=text):
                self.assertFalse(matches(text))
