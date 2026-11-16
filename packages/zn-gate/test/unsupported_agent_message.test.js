'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listAdapters, unsupportedAgentMessage } = require('../lib/agents');

const supportedPart = (msg) => /Supported agents: (.*)\.$/.exec(msg)[1];

test('the unsupported agent message names every supported id exactly once', () => {
  const ids = supportedPart(unsupportedAgentMessage('zzzzzzzz')).split(', ');
  assert.deepEqual([...ids].sort(), [...listAdapters()].sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('the supported ids are listed in the same fixed order as the registry', () => {
  const ids = supportedPart(unsupportedAgentMessage('zzzzzzzz')).split(', ');
  assert.deepEqual(ids, listAdapters());
  assert.equal(supportedPart(unsupportedAgentMessage('other-agent')), ids.join(', '));
});

test('supported ids and aliases give no message, in any letter case', () => {
  for (const id of [...listAdapters(), 'CLAUDE', 'Gemini-CLI', 'ClaudeCode']) {
    assert.equal(unsupportedAgentMessage(id), null, id);
  }
});

test('an unknown id with odd characters keeps the same supported list and ends the same way', () => {
  const plain = supportedPart(unsupportedAgentMessage('zzzzzzzz'));
  const odd = ['a b"c', "x'y;z", '../etc/agent', '\u202e\u0007 ', '\ud800', 'caf\u00e9\ud83d\ude00', 'a\nb', '$(id)', '%s%n'];
  for (const id of odd) {
    const msg = unsupportedAgentMessage(id);
    assert.match(msg, /^unknown agent "/, JSON.stringify(id));
    assert.equal(supportedPart(msg), plain, JSON.stringify(id));
    assert.doesNotMatch(msg, /[\u0000-\u001f\u2028\u2029\u202e]/u);
  }
});

test('the message is the same on every call for an odd id', () => {
  const id = 'we!rd\t\u0085id';
  assert.equal(unsupportedAgentMessage(id), unsupportedAgentMessage(id));
  assert.ok(unsupportedAgentMessage(id).startsWith('unknown agent "we!rdid".'));
});
