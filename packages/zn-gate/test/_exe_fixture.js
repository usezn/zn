'use strict';
// Fixture folders for the tests of the program checks (resolved executable, scriptRisk, "zn run").
//
// The broker refuses any program that lives in a temp folder before it looks at the other checks, so a fixture
// that sits under os.tmpdir() never reaches the group-writable, linked or in-project refusals. os.tmpdir() follows
// TMPDIR, and a checkout under it (CI runners, a work folder named after TMPDIR) puts every fixture under the
// package inside it. The fixtures stay under the package; what moves is the temp root: TMPDIR points at a fresh
// folder next to nothing the fixtures use. Production code is untouched: the check still reads os.tmpdir().
//
// The fixed system temp folders (/tmp, /var/tmp, ...) cannot be moved: a checkout inside one of them cannot run
// these tests, so assertFixturesOutsideTemp fails loudly instead of letting the refusals go unexercised.

const fs = require('fs');
const os = require('os');
const path = require('path');
const markers = require('../lib/broker/markers');

let moved = null;

/** Point os.tmpdir() at an empty folder that does not contain the package. Idempotent; restored at process exit. */
function moveTempRoot() {
  if (moved) return moved;
  const names = ['TMPDIR', 'TEMP', 'TMP'];
  const previous = names.map((n) => process.env[n]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-test-tmproot-'));
  for (const n of names) process.env[n] = root;
  moved = root;
  process.on('exit', () => {
    names.forEach((n, i) => { if (previous[i] === undefined) delete process.env[n]; else process.env[n] = previous[i]; });
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  });
  return root;
}

/** Throws when a fixture folder is still inside a temp folder, which would hide the refusals under test. */
function assertFixturesOutsideTemp(dir) {
  const real = fs.realpathSync.native(dir);
  const inside = markers.tempRoots().find((tmp) => {
    const rel = path.relative(tmp, real);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (inside) throw new Error('test fixtures are inside a temp folder (' + inside + '): the program checks under test would never run. Run the tests from a checkout outside the system temp folders.');
}

module.exports = { moveTempRoot, assertFixturesOutsideTemp };
