"""audit RF30-4: the Python policy against the shared spelling corpus of the Node tests (audit RF30-3).

The corpus is packages/zn-gate/test/fixtures/rule_spellings_corpus.json. `expect` is what a POSIX shell really does
with the text. Cases the Python rules do not catch yet are listed in KNOWN_GAPS and run as xfail (non-strict): they stay
visible, and a fix shows up as XPASS. The egress cases (a request that carries a secret) exist in the Node hooks only,
so they are skipped here. Only fake example.com URLs and fake paths.
ZN_CORPUS_REPORT=<file.json> writes the verdict of every case (id -> verdict) for the audit table.
"""
import json
import os

import pytest

from zn_gate.destructive import check_command

_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'zn-gate', 'test', 'fixtures', 'rule_spellings_corpus.json')
if not os.path.exists(_PATH):
    pytest.skip("the Node package's corpus is not next to this package", allow_module_level=True)
with open(_PATH, encoding='utf-8') as fh:
    CASES = [c for c in json.load(fh) if c['kind'] == 'destructive']

KNOWN_GAPS = {
    'pts-prog-008', 'pts-prog-010', 'pts-prog-011', 'pts-prog-025',
    'pts-prog-026', 'pts-prog-027', 'pts-prog-028', 'pts-prog-029',
    'pts-prog-030', 'pts-shell-010', 'pts-shell-021',
    'pts-shell-022', 'pts-shell-035', 'pts-shell-036', 
    'pts-subst-012', 'pts-subst-013',
    'pts-subst-014', 'pts-subst-015', 
    'pts-subst-020', 'pts-subst-021',
    'pts-subst-022', 'pts-subst-023', 'pts-subst-024', 'pts-subst-025',
    'pts-subst-028', 'pts-subst-031', 'rc-prog-008',
    'rc-prog-010', 'rc-prog-011', 'rc-prog-025', 'rc-prog-026',
    'rc-target-011', 'rc-target-012', 'rc-target-025', 'rc-target-026',
    'rc-target-027', 'rc-target-029', 'rc-target-036', 'rc-target-037',
    'rc-target-044', 'rc-target-047', 'rc-target-048', 'rc-target-049',
    'rc-target-050', 'rc-target-051',
}

REPORT = {}


def _verdict(cmd):
    r = check_command(cmd)
    return 'block:' + str(r.rule).replace('destructive:', '') if r.verdict == 'block' else 'allow'


@pytest.fixture(scope='module', autouse=True)
def _write_report():
    yield
    out = os.environ.get('ZN_CORPUS_REPORT')
    if out:
        with open(out, 'w', encoding='utf-8') as fh:
            json.dump(REPORT, fh, indent=1)


@pytest.mark.parametrize('case', [
    pytest.param(c, id=c['id'], marks=[pytest.mark.xfail(reason='audit RF30-4: allowed but a shell runs the dangerous command', strict=False)] if c['id'] in KNOWN_GAPS else [])
    for c in CASES
])
def test_spelling(case):
    v = _verdict(case['cmd'])
    REPORT[case['id']] = v
    ok = case['expect'] == 'either' or (v == 'allow' if case['expect'] == 'allow' else v.startswith('block'))
    assert ok, '%s expected %s, got %s: %r' % (case['id'], case['expect'], v, case['cmd'])
