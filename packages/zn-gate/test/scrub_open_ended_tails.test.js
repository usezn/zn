'use strict';
// A key with no fixed length (OpenAI, Anthropic, PyPI) wrapped across lines: the rest of the key is redacted with it,
// whatever it looks like, and text that holds no such key is left as it was. Same cases as
// tests/test_scrubber_open_ended_tails.py in the Python package. Every key is fictitious.
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets, redactScanSecrets } = require('../lib/rules');

const OPENAI = 'sk-proj-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ';
const PYPI = 'pypi-AgEIcHlwaS5vcmc' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ0123456789ABCDEF';

test('the last piece of a wrapped key, shorter than a joinable line, is redacted with it', () => {
  for (const [key, mark] of [[OPENAI, '[REDACTED_OPENAI_KEY]'], [PYPI, '[REDACTED_PYPI_TOKEN]']]) {
    for (const back of [1, 2, 4, 7, 9]) {
      const cut = key.length - back;
      for (const sep of ['\n', '\r\n', ' \n', '\n  ']) {
        const r = redactSecrets('token:\n' + key.slice(0, cut) + sep + key.slice(cut) + '\nhello world\n');
        assert.equal(r.sanitized, 'token:\n' + mark + '\nhello world\n', `${back} ${JSON.stringify(sep)}`);
      }
    }
  }
});

test('the rest of a key that the next line key was hiding is redacted too', () => {
  const next = 'sk-proj-' + 'Zz9yY8xX7wW6vV5uU4tT3sS2rR1qQ0pP9oO8nN7mM6';
  for (const back of [3, 9, 10, 16, 25]) {
    const cut = OPENAI.length - back;
    const r = redactSecrets(OPENAI.slice(0, cut) + '\n' + OPENAI.slice(cut) + '\n' + next);
    assert.equal(r.sanitized, '[REDACTED_OPENAI_KEY]\n[REDACTED_OPENAI_KEY]', `${back}`);
  }
});

test('the scan rules redact the rest of the key as well', () => {
  const r = redactScanSecrets(OPENAI.slice(0, -4) + '\n' + OPENAI.slice(-4) + '\nhello world\n');
  assert.equal(r.sanitized, '[REDACTED_OPENAI_KEY]\nhello world\n');
});

test('a line with more text after its first word, and a complete key, are left alone', () => {
  for (const next of ['see the notes below', 'const x = 1;', 'next line, with a comma', '{ "a": 1 }']) {
    assert.equal(redactSecrets(OPENAI + '\n' + next + '\n').sanitized, '[REDACTED_OPENAI_KEY]\n' + next + '\n', next);
  }
});

test('a closing quote or bracket after the rest of the key stays, the rest goes', () => {
  const r = redactSecrets('f("' + OPENAI.slice(0, -4) + '\n' + OPENAI.slice(-4) + '")\n');
  assert.equal(r.sanitized, 'f("[REDACTED_OPENAI_KEY]")\n');
});

test('text without such a key is left as it was, whatever its lines look like', () => {
  const texts = [
    'internationalization_configuration_manager\n_factory_for_services\n',
    'const veryLongFunctionNameThatKeepsGoingAndGoing =\n  anotherVeryLongIdentifierName;\n',
    'sk-learn is a library\nnumpy\n',
    'ask-the-ops-team-about-this-long-name-here\nok\n',
    'abcdefghijklmnopqrstuvwxyz0123456789\nabcdefghijklmnop\n',
    'plain\nnot a detection of this call\n',
  ];
  for (const t of texts) assert.equal(redactSecrets(t).sanitized, t, t);
});
