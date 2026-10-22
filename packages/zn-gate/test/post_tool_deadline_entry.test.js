'use strict';

process.env.ZN_STATS = 'off';

// The time budget of the post-tool check starts when the hook receives the event, not when the check
// itself begins. Time spent before it (reading the event, normalizing it) counts against the budget.
// The tests use a fake clock; none waits for real time.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getAdapter } = require('../lib/agents');
const runner = require('../lib/hooks/runner');
const fakeEngine = require('./helpers/fake_engine');
const { createFakeVault } = require('./helpers/fake_vault');
const { AGENTS } = require('./helpers/post_events');

const NOTICE = /output withheld because it is too large to check/;
const KEY = 'AKIAQQQQQQQQQQQQQQQQ'; // fictitious

function clock() {
  const c = { t: 1000000, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

for (const [name, a] of Object.entries(AGENTS)) {
  test(name + ': time spent normalizing the event counts against the post-tool budget', async () => {
    const c = clock();
    const real = getAdapter(name);
    const adapter = { ...real, normalize: (raw) => { c.advance(20000); return real.normalize(raw); } };
    const r = await runner.handle(adapter, a.event('a=' + KEY + ' b=more text here'), {
      engine: fakeEngine, vault: createFakeVault(), failMode: 'open', now: c.now, postDeadlineMs: 10000,
    });
    assert.equal(r.decision.decision, 'allow');
    assert.ok(!JSON.stringify(r.output).includes(KEY));
    assert.match(a.seen(r.output), NOTICE);
  });

  test(name + ': an instant taken earlier by the caller (startedAt) starts the budget', async () => {
    const c = clock();
    const r = await runner.handle(getAdapter(name), a.event('a=' + KEY + ' b=more text here'), {
      engine: fakeEngine, vault: createFakeVault(), failMode: 'open', now: c.now, startedAt: c.t - 20000, postDeadlineMs: 10000,
    });
    assert.ok(!JSON.stringify(r.output).includes(KEY));
    assert.match(a.seen(r.output), NOTICE);
  });

  test(name + ': inside the budget the output is redacted as before', async () => {
    const c = clock();
    const real = getAdapter(name);
    const adapter = { ...real, normalize: (raw) => { c.advance(2000); return real.normalize(raw); } };
    const r = await runner.handle(adapter, a.event('a=' + KEY + ' b=more text here'), {
      engine: fakeEngine, vault: createFakeVault(), failMode: 'open', now: c.now, postDeadlineMs: 10000,
    });
    const seen = a.seen(r.output);
    assert.ok(!seen.includes(KEY));
    assert.doesNotMatch(seen, NOTICE);
  });
}

test('main: time spent reading the event counts against the budget', async () => {
  const a = AGENTS['claude-code'];
  const realNow = Date.now;
  let t = 5000000;
  Date.now = () => t;
  const out = [];
  const realWrite = process.stdout.write;
  process.stdout.write = (chunk, cb) => { out.push(String(chunk)); if (typeof cb === 'function') cb(); return true; };
  try {
    await runner.main(['claude-code'], async () => { t += 20000; return JSON.stringify(a.event('a=' + KEY + ' b=more text here')); });
  } finally {
    process.stdout.write = realWrite;
    Date.now = realNow;
  }
  const text = out.join('');
  assert.ok(!text.includes(KEY));
  assert.match(text, NOTICE);
});
