'use strict';
// A vault daemon that accepts and never answers must not hold a PostToolUse hook
// until the agent's timeout: the output comes back redacted, fast.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { generateAll } = require('./fixtures/fake_secrets');

const RUNNER = path.resolve(__dirname, '..', 'lib', 'hooks', 'runner.js');
const FAKE = generateAll(4242, { perType: 1, piiPerType: 1 });
const SECRET = FAKE.secrets.find((s) => s.type === 'aws_access_key_id').value;

test('a hung vault daemon does not stop PostToolUse from redacting, and quickly', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-hang-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const runDir = path.join(home, '.zn', 'run');
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // Session key built at runtime; the server never replies to anything.
  fs.writeFileSync(path.join(runDir, 'session.key'), crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const sock = path.join(runDir, 'vault.sock');
  const server = net.createServer((c) => { c.on('data', () => {}); c.on('error', () => {}); });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());

  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-hang-proj-'));
  t.after(() => fs.rmSync(proj, { recursive: true, force: true }));
  const ev = {
    session_id: 's', cwd: proj, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'cat creds' }, tool_response: { stdout: 'key=' + SECRET + '\n', stderr: '', interrupted: false }, tool_use_id: 't1',
  };
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, 'claude-code'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ZN_HOME: path.join(home, '.zn'), ZN_STATS: 'off', ZN_HOOK_FAIL_MODE: '' },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(JSON.stringify(ev));
    setTimeout(() => p.kill('SIGKILL'), 12000).unref();
  });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, 'hook took ' + ms + ' ms');
  assert.equal(res.code, 0, res.err);
  assert.ok(!res.out.includes(SECRET), 'the secret was passed through');
  assert.match(res.out, /__ZN_REDACTED_/);
});
