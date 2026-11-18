'use strict';

// A log that an editor re-saved (leading UTF-8 byte order mark, Windows line endings) is told
// apart from a real edit. verify never changes the file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { logEvidence, verifyEvidenceLedger } = require('../lib/evidence');

const CLI = path.resolve(__dirname, '..', 'bin', 'cli.js');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function tmpLedger() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-resaved-'));
  fs.mkdirSync(path.join(home, '.zn'));
  const file = path.join(home, '.zn', 'evidence.jsonl');
  for (let i = 0; i < 3; i++) logEvidence({ payload: `example-${i}`, tool_name: 'bash' }, file);
  return { home, file };
}

const toCrlf = (buf) => Buffer.from(buf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
const withBom = (buf) => Buffer.concat([BOM, buf]);
const edited = (buf) => Buffer.from(buf.toString('utf8').replace('example-1', 'example-X'), 'utf8');

const CASES = {
  'BOM only': { make: withBom, reencoded: true },
  'BOM and CRLF': { make: (b) => withBom(toCrlf(b)), reencoded: true },
  'CRLF only': { make: toCrlf, reencoded: false, valid: true },
  'real edit': { make: edited, reencoded: false, tamper: true },
  'real edit and BOM': { make: (b) => withBom(edited(b)), reencoded: false, tamper: true },
  'real edit, BOM and CRLF': { make: (b) => withBom(toCrlf(edited(b))), reencoded: false, tamper: true },
};

for (const [name, c] of Object.entries(CASES)) {
  test(`verify: ${name}`, () => {
    const { home, file } = tmpLedger();
    try {
      const bytes = c.make(fs.readFileSync(file));
      fs.writeFileSync(file, bytes);
      const v = verifyEvidenceLedger(file);
      assert.deepEqual(fs.readFileSync(file), bytes, 'verify must not change the file');
      if (c.valid) {
        assert.equal(v.valid, true);
        assert.equal(v.crlf, true);
        assert.equal(v.reencoded, undefined);
      } else if (c.reencoded) {
        assert.equal(v.valid, false);
        assert.equal(v.reencoded, true);
        assert.equal(v.total, 3);
        assert.match(v.error, /byte order mark/);
        assert.match(v.error, /line 1/);
        assert.doesNotMatch(v.error, /Tamper/i);
      } else {
        assert.equal(v.valid, false);
        assert.equal(v.reencoded, undefined);
        assert.match(v.error, /Tamper detected at line 2/);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test(`cli --verify: ${name}`, () => {
    const { home, file } = tmpLedger();
    try {
      const bytes = c.make(fs.readFileSync(file));
      fs.writeFileSync(file, bytes);
      const r = spawnSync(process.execPath, [CLI, 'evidence', '--verify'], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
      });
      assert.deepEqual(fs.readFileSync(file), bytes, 'verify must not change the file');
      if (c.valid) {
        assert.equal(r.status, 0);
        assert.match(r.stdout, /ALL SHA-256 HASHES VERIFIED/);
        assert.match(r.stdout, /Windows line endings \(CRLF\)/);
      } else if (c.reencoded) {
        assert.equal(r.status, 1);
        assert.match(r.stdout, /LOG WAS RE-SAVED BY AN EDITOR/);
        assert.match(r.stdout, /byte order mark/);
        assert.match(r.stdout, /tail -c \+4|ReadAllBytes/);
        assert.doesNotMatch(r.stdout, /TAMPER DETECTED/);
      } else {
        assert.equal(r.status, 1);
        assert.match(r.stdout, /TAMPER DETECTED/);
        assert.doesNotMatch(r.stdout, /RE-SAVED/);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
