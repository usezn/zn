'use strict';
// `zn scan` does not read .git or node_modules: a fake key placed inside them is not reported, while the same key
// in a normal file is.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const ENV = { ...process.env, ZN_LOCAL_ONLY: 'true' };
const FAKE_KEY = 'AKIA' + 'ZNTESTFAKE' + '000000';

test('scan reports the fake key in a normal file and not the copies in .git and node_modules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-scan-ignored-'));
  try {
    for (const [rel, text] of Object.entries({
      'config/app.env': 'KEY=' + FAKE_KEY + '\n',
      '.git/config.md': 'KEY=' + FAKE_KEY + '\n',
      'node_modules/pkg/leak.md': 'KEY=' + FAKE_KEY + '\n',
    })) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    const r = spawnSync(process.execPath, [CLI, 'scan', dir, '--format', 'json'], { encoding: 'utf8', env: ENV, cwd: dir });
    const data = JSON.parse(r.stdout);
    const files = data.threats.map((th) => th.file.split(/[\\/]/).join('/'));
    assert.equal(files.length, 1, files.join(', '));
    assert.ok(files[0].endsWith('config/app.env'), files[0]);
    assert.ok(!r.stdout.includes(FAKE_KEY), 'the key value is not printed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
