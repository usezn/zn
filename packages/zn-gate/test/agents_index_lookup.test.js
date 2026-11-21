'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const agents = require('../lib/agents');
const { getAdapter, listAdapters, unsupportedAgentMessage, AGENT_IDS } = agents;

const errorOf = (id) => {
  try {
    getAdapter(id);
  } catch (e) {
    return e.message;
  }
  return null;
};

test('getAdapter resolves every alias to the adapter it stands for', () => {
  const aliases = {
    claude: 'claude-code',
    claudecode: 'claude-code',
    'gemini-cli': 'gemini',
    geminicli: 'gemini',
    'z.ai': 'zcode',
    zai: 'zcode',
  };
  for (const [alias, id] of Object.entries(aliases)) {
    assert.equal(getAdapter(alias).id, id, alias);
    assert.equal(getAdapter(alias), getAdapter(id), alias);
  }
});

test('getAdapter ignores letter case for ids and aliases', () => {
  for (const id of listAdapters()) {
    assert.equal(getAdapter(id.toUpperCase()).id, id, id);
  }
  assert.equal(getAdapter('Claude').id, 'claude-code');
  assert.equal(getAdapter('Z.AI').id, 'zcode');
});

test('getAdapter throws for an unknown id and lists the supported ids', () => {
  const msg = errorOf('example-agent');
  assert.equal(msg, 'unknown agent "example-agent" (supported: ' + listAdapters().join(', ') + ')');
});

test('getAdapter throws for a missing or empty id with an empty name', () => {
  for (const id of [undefined, null, '']) {
    assert.match(errorOf(id), /^unknown agent "" \(supported: /, String(id));
  }
});

test('getAdapter does not resolve inherited object keys', () => {
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.match(errorOf(id), /^unknown agent "/, id);
  }
});

test('listAdapters returns a new array each call that callers can change safely', () => {
  const first = listAdapters();
  assert.ok(Array.isArray(first));
  assert.notEqual(listAdapters(), first);
  first.push('example-agent');
  first.length = 0;
  assert.ok(listAdapters().length > 0);
  assert.ok(!listAdapters().includes('example-agent'));
});

test('AGENT_IDS is frozen and matches listAdapters', () => {
  assert.ok(Object.isFrozen(AGENT_IDS));
  assert.deepEqual([...AGENT_IDS], listAdapters());
});

test('unsupportedAgentMessage returns null for aliases in any letter case', () => {
  for (const id of ['claude', 'claudecode', 'gemini-cli', 'geminicli', 'z.ai', 'zai', 'ZAI', 'Z.Ai']) {
    assert.equal(unsupportedAgentMessage(id), null, id);
  }
});

test('unsupportedAgentMessage suggests the closest id for a near miss', () => {
  const supported = ' Supported agents: ' + listAdapters().join(', ') + '.';
  assert.equal(unsupportedAgentMessage('codx'), 'unknown agent "codx". Did you mean "codex"?' + supported);
  assert.match(unsupportedAgentMessage('cursr'), /Did you mean "cursor"\?/);
  assert.match(unsupportedAgentMessage('gemni'), /Did you mean "gemini"\?/);
});

test('unsupportedAgentMessage can suggest an alias', () => {
  assert.match(unsupportedAgentMessage('claud'), /^unknown agent "claud"\. Did you mean "claude"\?/);
});

test('unsupportedAgentMessage keeps the original case in the echo and matches the lower case', () => {
  assert.match(unsupportedAgentMessage('CODX'), /^unknown agent "CODX"\. Did you mean "codex"\?/);
});

test('unsupportedAgentMessage gives no suggestion when nothing is close', () => {
  const msg = unsupportedAgentMessage('example-unknown-agent');
  assert.equal(msg, 'unknown agent "example-unknown-agent". Supported agents: ' + listAdapters().join(', ') + '.');
  assert.doesNotMatch(msg, /Did you mean/);
});

test('unsupportedAgentMessage handles a missing or empty id', () => {
  const expected = 'unknown agent "". Supported agents: ' + listAdapters().join(', ') + '.';
  for (const id of [undefined, null, '']) {
    assert.equal(unsupportedAgentMessage(id), expected, String(id));
  }
});
