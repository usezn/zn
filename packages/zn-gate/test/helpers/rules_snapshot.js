'use strict';

// Snapshot of the rule layers. Shared by test/rules_snapshot.test.js and
// scripts/update-rules-snapshot.js so both compute exactly the same thing.
//
// A layer is a set of source files plus the version constant that must move
// with them. The snapshot stores, per layer, the version, the sorted rule ids
// and a sha256 of each file (line endings normalized to LF). Adding or
// removing a file in a layer counts as a change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PKG = path.join(__dirname, '..', '..');
const SNAPSHOT_FILE = path.join(PKG, 'test', 'fixtures', 'rules_snapshot.json');
const VERSION_FORMAT = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const UPDATE_HINT = 'run node scripts/update-rules-snapshot.js';
// Codes that the update script refuses to write over (unless --force).
const BLOCKING_CODES = ['unbumped', 'backwards', 'invalid'];

function load(rel) {
  return require(path.join(PKG, rel));
}

// Exported names, without the version constant. For layers that have no rule
// ids of their own (policy, command patterns, helpers), the exported API is
// the id set.
function exportedNames(mod) {
  return Object.keys(mod).filter((k) => !/_VERSION$/.test(k));
}

// Ids of every exported array whose items all carry a string `id`
// (the rule tables of lib/rules.js).
function ruleTableIds(mod) {
  const ids = [];
  for (const value of Object.values(mod)) {
    if (Array.isArray(value) && value.length > 0 && value.every((r) => r && typeof r.id === 'string')) {
      for (const r of value) ids.push(r.id);
    }
  }
  return ids;
}

const LAYERS = {
  rules: {
    files: ['lib/rules.js'],
    versionFile: 'lib/rules.js',
    versionConst: 'RULES_VERSION',
    ids: () => ruleTableIds(load('lib/rules.js')),
  },
  scrub: {
    files: ['lib/scrub/patterns.js', 'lib/scrub/exact.js'],
    versionFile: 'lib/scrub/patterns.js',
    versionConst: 'SCRUB_RULES_VERSION',
    ids: () => {
      const m = load('lib/scrub/patterns.js');
      const exact = load('lib/scrub/exact.js');
      return [...m.SECRET_TYPES, ...m.PII_TYPES].concat(exportedNames(exact).map((k) => 'exact.' + k));
    },
  },
  audit: {
    files: ['lib/audit/rules.js', 'lib/audit/patterns.js'],
    versionFile: 'lib/audit/rules.js',
    versionConst: 'AUDIT_RULES_VERSION',
    ids: () => {
      const rules = load('lib/audit/rules.js');
      const patterns = load('lib/audit/patterns.js');
      return rules.RULES.map((r) => r.id).concat(exportedNames(patterns).map((k) => 'patterns.' + k));
    },
  },
  policy: {
    files: [
      'lib/hooks/policy.js',
      'lib/broker/files.js',
      'lib/broker/markers.js',
      'lib/broker/dotenv.js',
      'lib/shell-quote.js',
    ],
    versionFile: 'lib/hooks/policy.js',
    versionConst: 'POLICY_RULES_VERSION',
    ids: () => exportedNames(load('lib/hooks/policy.js')),
  },
};

function sha256Normalized(absFile) {
  const text = fs.readFileSync(absFile, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// Versions are YYYY-MM-DD.N. Dates compare as strings; N compares as a number,
// so 2026-10-14.10 is newer than 2026-10-14.9. Returns <0, 0 or >0.
function compareVersions(a, b) {
  const [dateA, numA] = a.split('.');
  const [dateB, numB] = b.split('.');
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  return Number(numA) - Number(numB);
}

function computeLayer(name) {
  const def = LAYERS[name];
  const version = load(def.versionFile)[def.versionConst];
  if (typeof version !== 'string' || !VERSION_FORMAT.test(version)) {
    throw new Error(`${def.versionConst} must be exported from ${def.versionFile} as YYYY-MM-DD.N, got ${version}`);
  }
  const sha256 = {};
  for (const f of def.files) sha256[f] = sha256Normalized(path.join(PKG, f));
  return {
    version_const: def.versionConst,
    version,
    ids: def.ids().slice().sort(),
    sha256,
  };
}

function computeSnapshot() {
  const layers = {};
  for (const name of Object.keys(LAYERS)) layers[name] = computeLayer(name);
  return { layers };
}

function readSnapshot() {
  if (!fs.existsSync(SNAPSHOT_FILE)) return null;
  return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
}

function writeSnapshot(snapshot) {
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n');
}

// Returns a list of { code, message }:
//   invalid    the layer is not in the snapshot, or its snapshot version is malformed
//   unbumped   files changed but the version is the same as the snapshot's
//   backwards  files changed and the version is older than the snapshot's
//   stale      the snapshot needs regenerating (files changed with a newer version,
//              or the version moved without a file change)
//   ids        rule ids were added or removed
function compareLayer(name, expected, actual) {
  const def = LAYERS[name];
  const problems = [];
  if (!expected) {
    return [{ code: 'invalid', message: `layer "${name}" is missing from the snapshot: ${UPDATE_HINT}` }];
  }
  if (typeof expected.version !== 'string' || !VERSION_FORMAT.test(expected.version)) {
    return [{ code: 'invalid', message: `layer "${name}" has an invalid version in the snapshot: ${UPDATE_HINT}` }];
  }

  const changed = [];
  for (const file of Object.keys(actual.sha256)) {
    if (expected.sha256[file] === undefined) changed.push(`${file} (added to layer "${name}")`);
    else if (expected.sha256[file] !== actual.sha256[file]) changed.push(file);
  }
  for (const file of Object.keys(expected.sha256)) {
    if (actual.sha256[file] === undefined) changed.push(`${file} (removed from layer "${name}")`);
  }

  const order = compareVersions(actual.version, expected.version);
  if (changed.length) {
    for (const file of changed) {
      if (order === 0) {
        problems.push({
          code: 'unbumped',
          message: `rules changed in ${file}: bump ${def.versionConst} and run node scripts/update-rules-snapshot.js`,
        });
      } else if (order < 0) {
        problems.push({
          code: 'backwards',
          message: `rules changed in ${file} but ${def.versionConst} went backwards (${actual.version} is older than ${expected.version}): versions must increase`,
        });
      } else {
        problems.push({
          code: 'stale',
          message: `rules changed in ${file} and ${def.versionConst} moved to ${actual.version}: ${UPDATE_HINT}`,
        });
      }
    }
  } else if (order !== 0) {
    problems.push({
      code: 'stale',
      message: `${def.versionConst} is ${actual.version} but the snapshot has ${expected.version}: ${UPDATE_HINT}`,
    });
  }

  const before = new Set(expected.ids);
  const now = new Set(actual.ids);
  const added = actual.ids.filter((id) => !before.has(id));
  const removed = expected.ids.filter((id) => !now.has(id));
  if (added.length || removed.length) {
    problems.push({
      code: 'ids',
      message: `rule ids changed in layer "${name}" (added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}): ${UPDATE_HINT}`,
    });
  }
  return problems;
}

module.exports = {
  LAYERS,
  SNAPSHOT_FILE,
  BLOCKING_CODES,
  compareVersions,
  computeLayer,
  computeSnapshot,
  readSnapshot,
  writeSnapshot,
  compareLayer,
};
