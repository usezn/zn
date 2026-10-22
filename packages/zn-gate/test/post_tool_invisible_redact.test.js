'use strict';

process.env.ZN_STATS = 'off';

// Post-tool output that is mostly invisible characters is still redacted: the deny alone does not hide
// the output in Claude Code, Copilot or OpenCode, so the hook replaces the output for every agent that
// can take a replacement (Claude Code, Codex, Copilot, OpenCode, and Cursor for MCP tools). Gemini CLI
// and Antigravity have no post-tool rewrite in zn (see their adapters), so there is nothing to test there.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const fakeEngine = require('./helpers/fake_engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { AGENTS } = require('./helpers/post_events');

const ZW = String.fromCharCode(0x200b);
const KEY = 'AKIAIOSFODNN7EXAMPLE'; // AWS documentation example, not a credential
const HIDDEN = ZW.repeat(250000);
const WITHHELD = /output withheld because it is too large/;

function handle(adapter, raw, extra = {}) {
  return runner.handle(getAdapter(adapter), raw, { engine: fakeEngine, vault: createFakeVault(), failMode: 'open', ...extra });
}


for (const [name, a] of Object.entries(AGENTS)) {
  test(name + ': 250,000 invisible characters and a key: the key never reaches the agent', async () => {
    const r = await handle(name, a.event(HIDDEN + ' key=' + KEY + ' end'));
    assert.equal(r.decision.decision, 'deny');
    assert.match(r.decision.message, /mostly invisible characters/);
    assert.ok(r.output, 'the hook answers');
    const everything = JSON.stringify(r.output);
    assert.ok(!everything.includes(KEY), 'the key is absent from every field the agent receives');
    assert.ok(!everything.includes('IOSFODNN7EXAMPLE'));
    const seen = a.seen(r.output);
    assert.match(seen, /__ZN_AWS_KEY_1__/);
    assert.ok(!seen.includes(ZW), 'the invisible characters are removed');
    assert.ok(everything.length < 5000, 'the answer is small: ' + everything.length);
    assert.ok(a.shapeKept(r.output));
  });

  test(name + ': a key split by invisible characters is joined and redacted', async () => {
    const r = await handle(name, a.event(HIDDEN + 'AKIAIOSF' + ZW + ZW + 'ODNN7EXAMPLE'));
    assert.ok(!JSON.stringify(r.output).includes('ODNN7EXAMPLE'));
    assert.match(a.seen(r.output), /__ZN_AWS_KEY_1__/);
  });

  test(name + ': an output too large to check is withheld whole, with the key absent', async () => {
    const big = HIDDEN + 'x'.repeat(5000) + ' ' + KEY;
    const r = await handle(name, a.event(big), { postScanCap: 1000 });
    assert.equal(r.decision.decision, 'deny');
    assert.match(r.decision.message, /too large to check for secrets/);
    const everything = JSON.stringify(r.output);
    assert.ok(!everything.includes(KEY));
    assert.match(a.seen(r.output), WITHHELD);
    assert.ok(everything.length < 5000);
  });

  test(name + ': a normal output is not changed', async () => {
    const r = await handle(name, a.event('hello world, nothing to hide here'));
    assert.equal(r.decision.decision, 'allow');
    assert.ok(r.output === null || r.output === undefined || r.output.action === 'none', JSON.stringify(r.output));
  });

  test(name + ': a few invisible characters and a key are redacted as before', async () => {
    const r = await handle(name, a.event(ZW.repeat(1000) + ' key=' + KEY));
    assert.equal(r.decision.decision, 'allow');
    assert.match(a.seen(r.output), /__ZN_AWS_KEY_1__/);
    assert.ok(!JSON.stringify(r.output).includes(KEY));
  });
}

test('an output that is mostly invisible and has no key is still replaced, so it is not passed on', async () => {
  const r = await handle('claude-code', AGENTS['claude-code'].event(ZW.repeat(8 * 1024 * 1024) + 'visible text of the file'));
  assert.equal(r.decision.decision, 'deny');
  assert.equal(r.output.hookSpecificOutput.updatedToolOutput.stdout, 'visible text of the file');
  assert.match(r.output.hookSpecificOutput.additionalContext, /removed them/);
});

test('invisible characters spread over many strings count together and every string is cleaned', async () => {
  const parts = [];
  for (let i = 0; i < 4; i++) parts.push({ type: 'text', text: ZW.repeat(60000) + (i === 3 ? ' key=' + KEY : ' part ' + i) });
  const raw = AGENTS.cursor.event('x');
  raw.tool_output = JSON.stringify({ content: parts });
  const r = await handle('cursor', raw);
  assert.equal(r.decision.decision, 'deny');
  const out = r.output.updated_mcp_tool_output;
  assert.equal(out.content.length, 4);
  assert.ok(out.content.every((p) => p.type === 'text' && !p.text.includes(ZW)));
  assert.ok(!JSON.stringify(out).includes(KEY));
  assert.match(out.content[3].text, /__ZN_AWS_KEY_1__/);
});

test('the real engine redacts the key in the repro case', async () => {
  const engine = require('../lib/scrub/engine');
  const r = await runner.handle(getAdapter('claude-code'), AGENTS['claude-code'].event(HIDDEN + ' AWS_ACCESS_KEY_ID=' + KEY), { engine, vault: createFakeVault(), failMode: 'open' });
  assert.equal(r.decision.decision, 'deny');
  assert.ok(!JSON.stringify(r.output).includes(KEY));
  assert.match(r.output.hookSpecificOutput.updatedToolOutput.stdout, /__ZN_/);
});

test('the hook removes exactly the characters the rules count as invisible', () => {
  const rules = require('../lib/rules');
  const probe = (cp) => {
    const c = String.fromCodePoint(cp);
    return { rules: rules.invisibleView('a' + c + 'b') !== null, hook: ('a' + c + 'b').replace(runner.INVISIBLE_CHARS_RE, '') === 'ab' };
  };
  const ranges = [[0x20, 0x2FFFF], [0xE0000, 0xE0FFF]];
  for (const [from, to] of ranges) {
    for (let cp = from; cp <= to; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      const p = probe(cp);
      if (p.rules !== p.hook) assert.fail('U+' + cp.toString(16).toUpperCase() + ' differs: rules ' + p.rules + ', hook ' + p.hook);
    }
  }
});
