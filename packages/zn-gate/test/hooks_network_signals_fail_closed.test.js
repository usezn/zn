'use strict';

// hasNetworkSignals decides whether detected placeholders in a command may be filled with real values (a local
// command) or must stay placeholders (a command that can reach the network). When the second heuristic cannot run,
// the command is treated as one that can reach the network: values are never filled in because a check failed.

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../lib/hooks/policy');
const engine = require('../lib/scrub/engine');

// Only the second heuristic (HTTP libraries in inline code) sees this one; the plain word list does not.
const INLINE_HTTP = 'python3 -c "import requests; requests.get(\'https://example.invalid\')"'.replace('https://example.invalid', 'u');

test('the engine heuristic is what catches inline HTTP code', () => {
  assert.equal(engine.isNetworkCommand(INLINE_HTTP), true);
  assert.equal(policy.hasNetworkSignals(INLINE_HTTP), true);
});

test('when the engine heuristic fails, the command is treated as one that can reach the network', () => {
  const orig = engine.isNetworkCommand;
  engine.isNetworkCommand = () => { throw new Error('engine not available'); };
  try {
    assert.equal(policy.hasNetworkSignals(INLINE_HTTP), true);
    assert.equal(policy.hasNetworkSignals('npm test'), true, 'unsure means network, never local');
    assert.equal(policy.hasNetworkSignals('curl -s https://example.com'), true);
  } finally {
    engine.isNetworkCommand = orig;
  }
  assert.equal(policy.hasNetworkSignals('npm test'), false, 'a working engine still says local for a local command');
});
