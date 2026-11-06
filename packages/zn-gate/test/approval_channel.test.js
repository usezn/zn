'use strict';

// The commands only the person may run are confirmed on the vault's own channel when it is running.

process.env.ZN_STATS = 'off';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { confirmApproval } = require('../lib/broker/approval-channel');
const { main } = require('../lib/audit/cli');
const { baselinePath } = require('../lib/audit/baseline');
const { tempDir } = require('./helpers/tmp');

const locked = () => Object.assign(new Error('vault locked'), { code: 'ZN_LOCKED' });
const denied = () => Object.assign(new Error('declined by the user. Next step: nothing was changed.'), { code: 'ZN_POLICY_DENIED' });

test('with the vault running, the answer is the vault\'s; locked or not running falls back to the terminal; a refusal is a refusal', async () => {
  const asked = [];
  const yes = { confirmApproval: async (...a) => { asked.push(a); return true; } };
  assert.deepEqual(await confirmApproval('audit', '/p', '3 entries', { vault: yes }), { ok: true, via: 'vault' });
  assert.deepEqual(asked, [['audit', '/p', '3 entries']]);
  assert.deepEqual(await confirmApproval('audit', '/p', 'x', { vault: { confirmApproval: async () => { throw locked(); } } }), { ok: true, via: 'terminal' });
  const no = await confirmApproval('pins', '/p', 'all', { vault: { confirmApproval: async () => { throw denied(); } } });
  assert.equal(no.ok, false);
  assert.match(no.error.message, /declined/);
  const other = await confirmApproval('audit', '/p', 'x', { vault: { confirmApproval: async () => { throw new Error('boom'); } } });
  assert.equal(other.ok, false);
});

function setup(t) {
  const dir = tempDir(t, 'zn-ac-');
  const home = tempDir(t, 'zn-ac-home-');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'node' } } }));
  return { dir, home };
}
async function run(args, io) {
  let out = '';
  let err = '';
  const code = await main(args, Object.assign({ stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, env: {}, stdin: { isTTY: true }, ancestry: () => null }, io));
  return { code, out, err };
}

test('zn audit --approve at a terminal with the vault running asks the vault, and a "no" records nothing', async (t) => {
  const { dir, home } = setup(t);
  const calls = [];
  const ok = await run([dir, '--approve'], { home, vault: { confirmApproval: async (...a) => { calls.push(a); return true; } } });
  assert.equal(ok.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'audit');
  assert.ok(fs.existsSync(baselinePath(home, dir)));
  const { dir: dir2, home: home2 } = setup(t);
  const no = await run([dir2, '--approve'], { home: home2, vault: { confirmApproval: async () => { throw denied(); } } });
  assert.equal(no.code, 2);
  assert.match(no.err, /declined/);
  assert.ok(!fs.existsSync(baselinePath(home2, dir2)), 'nothing recorded');
  const { dir: dir3, home: home3 } = setup(t);
  const down = await run([dir3, '--approve'], { home: home3, vault: { confirmApproval: async () => { throw locked(); } } });
  assert.equal(down.code, 0, 'no vault running: the terminal check stands');
});
