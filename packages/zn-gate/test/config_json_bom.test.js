'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('../lib/hooks/runner');
const cloudKey = require('../lib/cloud-key');
const statsShare = require('../lib/stats-share');

const BOM = '﻿';

// Writes ~/.zn/config.json under a temp home and runs fn with ZN_HOME pointing at that folder.
function withConfig(text, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-config-bom-'));
  const znDir = path.join(home, '.zn');
  fs.mkdirSync(znDir, { recursive: true });
  fs.writeFileSync(path.join(znDir, 'config.json'), text, 'utf8');
  const saved = process.env.ZN_HOME;
  process.env.ZN_HOME = znDir;
  try {
    return fn(home);
  } finally {
    if (saved === undefined) delete process.env.ZN_HOME; else process.env.ZN_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('hooks reader accepts a config.json saved with a BOM', () => {
  withConfig(BOM + '{"hooks":{"whenUnavailable":"allow"}}', (home) => {
    assert.deepEqual(runner.readConfig(home), { hooks: { whenUnavailable: 'allow' } });
  });
});

test('hooks reader treats a BOM-only config.json like an empty file', () => {
  withConfig(BOM, (home) => {
    assert.deepEqual(runner.readConfig(home), {});
  });
  withConfig('', (home) => {
    assert.deepEqual(runner.readConfig(home), {});
  });
});

test('hooks reader still returns no settings for invalid JSON after a BOM', () => {
  withConfig(BOM + '{"hooks":', (home) => {
    assert.deepEqual(runner.readConfig(home), {});
  });
});

test('cloud key marker is read from a config.json saved with a BOM', () => {
  const cloud = { store: 'keychain', connectedAt: '2026-11-01T00:00:00.000Z', last4: 'abcd' };
  withConfig(BOM + JSON.stringify({ cloud }), () => {
    assert.deepEqual(cloudKey.readMarker(), { store: 'keychain', connectedAt: cloud.connectedAt, last4: 'abcd' });
  });
});

test('cloud key marker reads as absent for a BOM-only config.json', () => {
  withConfig(BOM, () => {
    assert.equal(cloudKey.readMarker(), null);
  });
});

test('stats sharing setting is read from a config.json saved with a BOM', () => {
  withConfig(BOM + '{"stats":{"share":true,"install_id":"abc123","sent_until":"2026-11-01"}}', () => {
    const s = statsShare.status();
    assert.equal(s.share, true);
    assert.equal(s.install_id, 'abc123');
  });
});

test('stats sharing setting is off for a BOM-only config.json', () => {
  withConfig(BOM, () => {
    assert.equal(statsShare.status().share, false);
  });
});
