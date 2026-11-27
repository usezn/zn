"""Two secrets on adjacent lines are two detections, each with its own rule, and a key wrapped across two lines is one
(same cases as test/scrub_adjacent_secrets.test.js in the Node package). Every value is a fictitious key."""
import pytest

from zn_gate.rules import redact_secrets

# name -> (fake key, rule that reports it)
KEYS = {
    'github': ('ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5', 'secret:github_token'),
    'aws': ('AKIAIOSFODNN7EXAMPLE', 'secret:aws_access_key'),
    'anthropic': ('sk-ant-api03-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9', 'secret:anthropic_key'),
    'huggingface': ('hf_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3j', 'secret:hf_token'),
    'npm': ('npm_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5', 'secret:npm_token'),
    'slack': ('xoxb-' + '123456789012-123456789012-aB3dE5gH7jK9mN1pQ3sT5vW7', 'secret:slack_token'),
    'stripe': ('sk_live_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7', 'secret:stripe_key'),
    'openai': ('sk-proj-' + 'EXAMPLE' + '0' * 28, 'secret:openai_key'),
    'pypi': ('pypi-AgE' + 'EXAMPLE' + '0' * 19 + '111122233445566778899BCDFGHNOQR', 'secret:pypi_token'),
}
BODIES = ('aB3d', 'EXAMPLE')
SEPARATORS = ['\n', '\r\n', '\n  ']
PAIRS = [(a, b) for a in KEYS for b in KEYS]


def _leaks(out):
    return [b for b in BODIES if b in out]


@pytest.mark.parametrize('sep', SEPARATORS, ids=['lf', 'crlf', 'indented'])
@pytest.mark.parametrize('a,b', PAIRS)
def test_two_keys_on_adjacent_lines_are_two_detections(a, b, sep):
    first, rule_a = KEYS[a]
    second, rule_b = KEYS[b]
    out, found = redact_secrets(first + sep + second)
    assert not _leaks(out), out
    assert sorted(d['rule'] for d in found) == sorted([rule_a, rule_b]), found


def test_different_keys_on_adjacent_lines_keep_two_rule_names():
    out, found = redact_secrets(KEYS['openai'][0] + '\n' + KEYS['pypi'][0])
    assert out == '[REDACTED_OPENAI_KEY]\n[REDACTED_PYPI_TOKEN]'
    assert {d['rule'] for d in found} == {'secret:openai_key', 'secret:pypi_token'}


def test_three_keys_on_three_lines():
    text = '\n'.join(KEYS[n][0] for n in ('openai', 'pypi', 'github'))
    out, found = redact_secrets(text)
    assert not _leaks(out), out
    assert len(found) == 3, found


@pytest.mark.parametrize('name', ['github', 'openai', 'pypi', 'huggingface', 'npm'])
@pytest.mark.parametrize('cut', [10, 20])
def test_a_key_wrapped_across_lines_is_one_detection(name, cut):
    key, rule = KEYS[name]
    text = 'token:\n' + key[:cut] + '\n' + key[cut:] + '\n'
    out, found = redact_secrets(text)
    assert not _leaks(out), out
    assert key[cut:] not in out and key[:cut] not in out, out
    assert [d['rule'] for d in found] == [rule], found


def test_a_wrapped_key_then_another_key_is_two_detections():
    key, rule = KEYS['github']
    other, other_rule = KEYS['pypi']
    text = key[:20] + '\n' + key[20:] + '\n' + other
    out, found = redact_secrets(text)
    assert not _leaks(out), out
    assert key[20:] not in out, out
    assert sorted(d['rule'] for d in found) == sorted([rule, other_rule]), found
