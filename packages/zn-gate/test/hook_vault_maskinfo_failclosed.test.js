'use strict';
// A failing maskInfo (Daybreak finding): the hook must deny pre-tool and withhold post-tool; a vault that is
// unavailable on purpose (not running / locked) keeps allowing.
const test = require('node:test');
const assert = require('node:assert');
const runner = require('../lib/hooks/runner');
const engine = require('../lib/scrub/engine');
const { znError, CODES } = require('../lib/errors');

const SECRET = 'plugh-plugh-plugh-plugh';
function adapter(ev) { return { id: 'claude-code', normalize: () => Object.assign({ cwd: process.cwd() }, ev), respond: (d) => d }; }
function run(ev, vault) { return runner.handle(adapter(ev), {}, { home: process.env.HOME, vault, engine }); }
const pre = { event: 'pre_tool', tool: 'webfetch', toolName: 'WebFetch', input: { url: 'https://example.com/?q=' + SECRET } };
const post = { event: 'post_tool', tool: 'bash', output: SECRET };

const failures = {
  'generic error': () => new Error('connection closed'),
  'daemon refusal': () => znError(CODES.POLICY_DENIED, 'refused'),
  'vault did not answer': () => Object.assign(znError(CODES.LOCKED, 'timeout'), { vaultUnanswered: true }),
};
for (const [name, mk] of Object.entries(failures)) {
  test('maskInfo failure (' + name + '): pre-tool is denied, never allowed', async () => {
    const r = await run(pre, { maskInfo: async () => { throw mk(); } });
    assert.strictEqual(r.decision.decision, 'deny');
    assert.strictEqual(r.decision.failClosed, true);
  });
  test('maskInfo failure (' + name + '): post-tool output is withheld', async () => {
    const r = await run(post, { maskInfo: async () => { throw mk(); } });
    assert.ok(r.decision.updatedOutput && !String(r.decision.updatedOutput).includes(SECRET));
    assert.ok(/hidden/.test(String(r.decision.updatedOutput)));
  });
}

test('maskInfo answering nothing useful is still a plain answer; a vault unavailable on purpose keeps allowing', async () => {
  for (const mk of [() => znError(CODES.LOCKED, 'vault is locked'), () => Object.assign(znError(CODES.LOCKED, 'x'), { vaultNotRunning: true })]) {
    const r = await run(pre, { maskInfo: async () => { throw mk(); } });
    assert.notStrictEqual(r.decision.decision, 'deny');
    const p = await run(post, { maskInfo: async () => { throw mk(); } });
    assert.ok(!p.decision.failClosed);
  }
  const none = await run(pre, null);
  assert.notStrictEqual(none.decision.decision, 'deny');
});
