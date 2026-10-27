'use strict';
/*
 * A vault request that times out must not leave its socket open: the connection is destroyed, so the hook
 * process can exit, and an answer that arrives after the deadline is never read or used. The client the hook
 * created is closed when the hook is done.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempDir } = require('./helpers/tmp');

const CLIENT = path.join(__dirname, '..', 'lib', 'vault', 'client.js');

// The child shortens the 15 s vault deadline to 150 ms, runs a fake daemon that answers hello and auth and then
// stays silent (or answers late), and exits only if nothing keeps the event loop alive.
const CHILD = `
const fs = require('fs'), net = require('net'), path = require('path');
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 15000 ? ms / 100 : ms, ...a);
const vault = require(process.env.CLIENT);
const home = process.env.HOME_DIR;
fs.mkdirSync(path.join(home, 'run'), { recursive: true, mode: 0o700 });
const ep = vault.endpoint({ home });
fs.writeFileSync(ep.keyFile, 'a'.repeat(64), { mode: 0o600 });
const key = Buffer.from('a'.repeat(64), 'hex');
const late = process.env.LATE === '1';
const server = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.unref();
  let data = '';
  socket.on('data', (c) => {
    data += c;
    let nl;
    while ((nl = data.indexOf('\\n')) >= 0) {
      const msg = JSON.parse(data.slice(0, nl)); data = data.slice(nl + 1);
      if (msg.op === 'hello') socket.write(JSON.stringify({ ok: true, v: 1, nonce: 'b'.repeat(32), proof: vault.hmac(key, 'zn-server', msg.nonce, 'b'.repeat(32)) }) + '\\n');
      else if (msg.op === 'auth') socket.write(JSON.stringify({ ok: true }) + '\\n');
      else if (late) realSetTimeout(() => { try { socket.write(JSON.stringify({ id: msg.id, ok: true, result: { spans: [] } }) + '\\n'); } catch (e) {} }, 400);
    }
  });
});
server.listen(ep.address, () => {
  server.unref();
  const c = vault.createClient({ home });
  c.maskInfo('/p').then(
    () => { console.log('RESULT answered'); },
    async (err) => {
      const s = await Promise.race([c.conn, Promise.resolve(null)]);
      console.log('RESULT ' + err.code + ' conn=' + (s ? 'kept' : 'dropped'));
    });
  process.on('exit', () => console.log('EXITED'));
});
`;

function run(t, late) {
  const home = tempDir(t, 'zvs-');
  return spawnSync(process.execPath, ['-e', CHILD], {
    env: { ...process.env, CLIENT, HOME_DIR: home, LATE: late ? '1' : '0' },
    encoding: 'utf8', timeout: 10000,
  });
}

test('a timed-out vault request destroys its socket and the process exits by itself', { skip: process.platform === 'win32' }, (t) => {
  const r = run(t, false);
  assert.equal(r.error, undefined, 'the process kept running after the deadline: ' + (r.error && r.error.message));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /RESULT ZN_LOCKED conn=dropped/);
  assert.match(r.stdout, /EXITED/);
});

test('an answer that arrives after the deadline is ignored', { skip: process.platform === 'win32' }, (t) => {
  const r = run(t, true);
  assert.equal(r.error, undefined, 'the process kept running after the deadline');
  assert.match(r.stdout, /RESULT ZN_LOCKED/);
  assert.doesNotMatch(r.stdout, /RESULT answered/);
});

test('close() destroys the socket of a connected client', async () => {
  const { VaultClient } = require('../lib/vault/client');
  const c = new VaultClient({});
  let destroyed = false;
  const state = { socket: { destroy() { destroyed = true; } }, pending: new Map() };
  let rejected = null;
  state.pending.set(1, { reject: (e) => { rejected = e; } });
  c.conn = Promise.resolve(state);
  c.close();
  await new Promise((r) => setImmediate(r));
  assert.equal(destroyed, true);
  assert.ok(rejected);
  assert.equal(c.conn, null);
});
