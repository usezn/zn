'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');

// Rows of the Package | Version | License | Source table.
function tableRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4 || cells[0] === 'Package' || /^-+$/.test(cells[0])) continue;
    rows.push({ name: cells[0], version: cells[1], license: cells[2], source: cells[3] });
  }
  return rows;
}

test('notices table has the expected columns', () => {
  assert.match(notices, /^\| Package \| Version \| License \| Source \|$/m);
  assert.ok(tableRows(notices).length > 0);
});

test('every bundled dependency is listed with the version pinned in package.json', () => {
  const bundled = pkg.bundleDependencies || [];
  assert.ok(bundled.length > 0, 'package.json bundles at least one dependency');
  const rows = tableRows(notices);
  for (const name of bundled) {
    const pinned = (pkg.dependencies || {})[name];
    assert.ok(pinned, name + ' is bundled but not in dependencies');
    assert.match(pinned, /^\d+\.\d+\.\d+/, name + ' must be pinned to an exact version');
    const versions = rows.filter((r) => r.name === name).map((r) => r.version);
    assert.ok(versions.length > 0, name + ' is missing from THIRD_PARTY_NOTICES.md');
    assert.ok(versions.includes(pinned), name + ' pinned at ' + pinned + ' but notices list ' + versions.join(', '));
  }
});

test('the files list of package.json includes the notices file', () => {
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes('THIRD_PARTY_NOTICES.md'));
  assert.ok(fs.existsSync(path.join(root, 'THIRD_PARTY_NOTICES.md')));
});
