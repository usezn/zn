'use strict';

// Snapshot of the rule layers. Shared by test/rules_snapshot.test.js and
// scripts/update-rules-snapshot.js so both compute exactly the same thing.
//
// A layer is a set of source files plus the version constant that must move
// with them. The snapshot stores, per layer, the version, the sorted rule ids
// and a sha256 of each file (line endings normalized to LF).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PKG = path.join(__dirname, '..', '..');
const SNAPSHOT_FILE = path.join(PKG, 'test', 'fixtures', 'rules_snapshot.json');
const VERSION_FORMAT = /^\d{4}-\d{2}-\d{2}\.\d+$/;

function load(rel) {
  return require(path.join(PKG, rel));
}

// Exported names, without the version constant. For layers that have no rule
// ids of their own (policy, command patterns), the exported API is the id set.
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
    files: ['lib/scrub/patterns.js'],
    versionFile: 'lib/scrub/patterns.js',
    versionConst: 'SCRUB_RULES_VERSION',
    ids: () => {
      const m = load('lib/scrub/patterns.js');
      return [...m.SECRET_TYPES, ...m.PII_TYPES];
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
    files: ['lib/hooks/policy.js'],
    versionFile: 'lib/hooks/policy.js',
    versionConst: 'POLICY_RULES_VERSION',
    ids: () => exportedNames(load('lib/hooks/policy.js')),
  },
};

function sha256Normalized(absFile) {
  const text = fs.readFileSync(absFile, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
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

const UPDATE_HINT = 'run node scripts/update-rules-snapshot.js';

// Returns a list of { code, message }. code 'unbumped' means a file changed
// while its layer version stayed the same.
function compareLayer(name, expected, actual) {
  const def = LAYERS[name];
  const problems = [];
  if (!expected) {
    return [{ code: 'missing', message: `layer "${name}" is missing from the snapshot: ${UPDATE_HINT}` }];
  }
  for (const file of Object.keys(actual.sha256)) {
    if (expected.sha256[file] === undefined) {
      problems.push({ code: 'stale', message: `${file} is not in the snapshot: ${UPDATE_HINT}` });
    } else if (expected.sha256[file] !== actual.sha256[file]) {
      if (expected.version === actual.version) {
        problems.push({
          code: 'unbumped',
          message: `rules changed in ${file}: bump ${def.versionConst} and run node scripts/update-rules-snapshot.js`,
        });
      } else {
        problems.push({
          code: 'stale',
          message: `${file} changed and ${def.versionConst} is now ${actual.version}: ${UPDATE_HINT}`,
        });
      }
    }
  }
  for (const file of Object.keys(expected.sha256)) {
    if (actual.sha256[file] === undefined) {
      problems.push({ code: 'stale', message: `${file} is in the snapshot but no longer in layer "${name}": ${UPDATE_HINT}` });
    }
  }
  if (expected.version !== actual.version && problems.length === 0) {
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
  computeLayer,
  computeSnapshot,
  readSnapshot,
  writeSnapshot,
  compareLayer,
};
