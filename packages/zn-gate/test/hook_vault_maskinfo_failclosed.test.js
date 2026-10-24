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
const pre = { event: 'pre_tool', tool: 'webfetch', input: { url: 'https://example.com/?q=' + SECRET } };
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

test('the deny message for a vault failure points to the vault (unlock), not to reinstalling hooks', async () => {
  const r = await run(pre, { maskInfo: async () => { throw new Error('connection closed'); } });
  assert.ok(/zn unlock/.test(r.decision.message), r.decision.message);
  assert.ok(!/reinstall|hooks install|something went wrong inside/i.test(r.decision.message), r.decision.message);
});

test('a maskInfo answer of the wrong shape is a vault failure, not an empty vault', async () => {
  for (const bad of [null, 'x', 7, [], { names: 'a' }]) {
    const r = await run(pre, { maskInfo: async () => bad });
    assert.strictEqual(r.decision.decision, 'deny', JSON.stringify(bad));
    await assert.rejects(engine.prepare({ project: '/p', vault: { maskInfo: async () => bad } }), (e) => e.vaultFailed === true);
  }
  // an empty but well-formed answer is an empty vault
  const ok = await engine.prepare({ project: '/p2', vault: { maskInfo: async () => ({ names: [], count: 0, longest: 0 }) } });
  assert.strictEqual(ok.vaultLocked, false);
});

test('a late close of an old vault socket does not drop the newer connection', async () => {
  const net = require('net');
  const os = require('os'); const fs = require('fs'); const path = require('path');
  const { EventEmitter } = require('events');
  const { VaultClient } = require('../lib/vault/client');
  const store = require('../lib/vault/store');
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-late-close-'));
  const run = store.paths({ home }).runDir;
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(run, 'session.key'), 'a'.repeat(64), { mode: 0o600 });
  const made = [];
  const orig = net.createConnection;
  net.createConnection = () => { const s = new EventEmitter(); Object.assign(s, { setEncoding() {}, write() {}, destroy() {}, unref() {} }); made.push(s); return s; };
  try {
    const c = new VaultClient({ home });
    const first = c._connect(); first.catch(() => {});
    made[0].emit('error', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    await assert.rejects(first);
    const second = c._connect(); second.catch(() => {});
    assert.strictEqual(made.length, 2);
    made[0].emit('close');
    assert.strictEqual(c.conn, second, 'the newer connection is still the current one');
    assert.strictEqual(c._connect(), second);
  } finally { net.createConnection = orig; fs.rmSync(home, { recursive: true, force: true }); }
});
