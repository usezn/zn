'use strict';
// lib/stats.js with two processes recording events at the same moment in one temporary home.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stats-concurrent-'));
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const lib = path.join(__dirname, '..', 'lib', 'stats.js');
const child = (name, go) => `
  const s = require(${JSON.stringify(lib)});
  const wait = () => { if (Date.now() < ${go}) return setImmediate(wait); s.recordEvent(${JSON.stringify(name)}); };
  wait();
`;
const run = (name, go, env) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['-e', child(name, go)], { env, stdio: 'ignore' });
  p.on('close', (code) => resolve(code));
});

test('two processes recording at the same moment leave valid JSON and no temporary files', async () => {
  const env = { ...process.env, ZN_HOME: home, HOME: home, USERPROFILE: home };
  delete env.ZN_STATS;
  const file = path.join(home, 'stats.json');
  for (let round = 0; round < 5; round++) {
    fs.rmSync(file, { force: true });
    const go = Date.now() + 400;
    const codes = await Promise.all([run('alpha', go, env), run('beta', go, env)]);
    assert.deepEqual(codes, [0, 0]);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Recording is read-modify-write without a lock (see lib/stats.js), so one of the two increments
    // may be lost. What must hold: the file parses, no count is invented, and at least one event is kept.
    const kept = Object.entries(data.events);
    assert.ok(kept.length >= 1, `round ${round}`);
    for (const [name, n] of kept) {
      assert.ok(name === 'alpha' || name === 'beta', name);
      assert.equal(n, 1, name);
    }
    assert.deepEqual(fs.readdirSync(home), ['stats.json']);
  }
});
