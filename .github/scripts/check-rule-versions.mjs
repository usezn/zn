// Checks the rule-layer versions of a pull request against its base branch.
//
//   node .github/scripts/check-rule-versions.mjs <base-ref>     (for example origin/next)
//
// Versions look like YYYY-MM-DD.N. The date compares as text and N as an integer, so
// 2026-10-22.10 is newer than 2026-10-22.9. A pull request fails when:
//   - a version is older than the one at the merge base with <base-ref>;
//   - files of a layer changed since the merge base but the layer's version did not;
//   - the Node and Python packages disagree on RULES_VERSION or COMMAND_RULES_VERSION.
// A constant that does not exist at the merge base (a new layer) is accepted.
// Tests: node --test .github/scripts/check-rule-versions.test.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
// One implementation of the ordering and of the layer file lists: the snapshot helper.
const snapshot = require(path.join(ROOT, 'packages', 'zn-gate', 'test', 'helpers', 'rules_snapshot.js'));
export const { compareVersions } = snapshot;

export const VERSION_FORMAT = /^\d{4}-\d{2}-\d{2}\.\d+$/;

const NODE = 'packages/zn-gate/';
const PY = 'packages/zn-gate-py/src/zn_gate/';

function nodeLayer(name) {
  const def = snapshot.LAYERS[name];
  return {
    id: `node:${def.versionConst}`,
    lang: 'node',
    constName: def.versionConst,
    versionFile: NODE + def.versionFile,
    files: def.files.map((f) => NODE + f),
  };
}

// Every version constant, the file that holds it and the files that must move with it.
export const SPECS = [
  nodeLayer('rules'),
  nodeLayer('scrub'),
  nodeLayer('audit'),
  nodeLayer('policy'),
  {
    id: 'node:COMMAND_RULES_VERSION',
    lang: 'node',
    constName: 'COMMAND_RULES_VERSION',
    versionFile: NODE + 'lib/destructive.js',
    files: [NODE + 'lib/destructive.js'],
  },
  {
    id: 'py:RULES_VERSION',
    lang: 'py',
    constName: 'RULES_VERSION',
    versionFile: PY + 'rules.py',
    files: [PY + 'rules.py'],
  },
  {
    id: 'py:COMMAND_RULES_VERSION',
    lang: 'py',
    constName: 'COMMAND_RULES_VERSION',
    versionFile: PY + 'destructive.py',
    files: [PY + 'destructive.py'],
  },
];

// Pairs that must hold the same value in the Node and the Python package.
export const PARITY = [
  ['node:RULES_VERSION', 'py:RULES_VERSION'],
  ['node:COMMAND_RULES_VERSION', 'py:COMMAND_RULES_VERSION'],
];

// Reads the string assigned to a version constant from source text, or null.
export function extractVersion(text, spec) {
  if (typeof text !== 'string') return null;
  const lead = spec.lang === 'py' ? '^' : '^\\s*(?:const|let|var)\\s+';
  const re = new RegExp(`${lead}${spec.constName}\\s*=\\s*(['"])([^'"\\r\\n]*)\\1`, 'm');
  const m = re.exec(text);
  return m ? m[2] : null;
}

// head and base map a spec id to the version string (null or undefined when absent).
// changedFiles lists the files that differ between the merge base and HEAD.
// Returns a list of messages; empty means the check passed.
export function checkVersions({ specs = SPECS, head, base, changedFiles, parity = PARITY }) {
  const changed = new Set(changedFiles);
  const problems = [];
  for (const spec of specs) {
    const h = head[spec.id];
    const b = base[spec.id];
    if (typeof h !== 'string' || !VERSION_FORMAT.test(h)) {
      problems.push(`${spec.constName} in ${spec.versionFile} must be YYYY-MM-DD.N, got ${h == null ? 'nothing' : JSON.stringify(h)}`);
      continue;
    }
    if (typeof b !== 'string' || !VERSION_FORMAT.test(b)) continue; // new at the base, or not comparable
    const order = compareVersions(h, b);
    if (order < 0) {
      problems.push(`${spec.constName} in ${spec.versionFile} went backwards: ${h} is older than ${b} on the base branch`);
    } else if (order === 0) {
      const touched = spec.files.filter((f) => changed.has(f));
      if (touched.length) {
        problems.push(`${touched.join(', ')} changed but ${spec.constName} in ${spec.versionFile} is still ${h}: bump it`);
      }
    }
  }
  const byId = new Map(specs.map((s) => [s.id, s]));
  for (const [a, b] of parity) {
    const sa = byId.get(a);
    const sb = byId.get(b);
    if (!sa || !sb) continue;
    const va = head[a];
    const vb = head[b];
    if (VERSION_FORMAT.test(va ?? '') && VERSION_FORMAT.test(vb ?? '') && va !== vb) {
      problems.push(`${sa.constName} differs between packages: ${sa.versionFile} has ${va}, ${sb.versionFile} has ${vb}`);
    }
  }
  return problems;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitShow(rev, file) {
  try {
    return git(['show', `${rev}:${file}`]);
  } catch {
    return null; // the file does not exist at that revision
  }
}

export function main(argv) {
  const baseRef = argv[2];
  if (!baseRef) {
    console.error('usage: node .github/scripts/check-rule-versions.mjs <base-ref>');
    return 2;
  }
  let mergeBase;
  try {
    mergeBase = git(['merge-base', baseRef, 'HEAD']).trim();
  } catch (e) {
    console.error(`cannot find the merge base of ${baseRef} and HEAD (is the base ref fetched, with enough history?): ${String(e.stderr || e.message).trim()}`);
    return 2;
  }
  const head = {};
  const base = {};
  for (const spec of SPECS) {
    let text = null;
    try {
      text = readFileSync(path.join(ROOT, spec.versionFile), 'utf8');
    } catch {
      /* missing at HEAD: reported by checkVersions */
    }
    head[spec.id] = extractVersion(text, spec);
    base[spec.id] = extractVersion(gitShow(mergeBase, spec.versionFile), spec);
  }
  const changedFiles = git(['diff', '--name-only', '--no-renames', mergeBase]).split('\n').filter(Boolean);
  const problems = checkVersions({ head, base, changedFiles });
  if (problems.length) {
    console.error(`Rule version check failed (compared with ${baseRef} at ${mergeBase.slice(0, 10)}):`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('Versions are YYYY-MM-DD.N: the date compares as text and N as an integer, so .10 is newer than .9.');
    return 1;
  }
  console.log(`Rule versions OK against ${baseRef} (${SPECS.length} constants checked)`);
  for (const spec of SPECS) console.log(`  ${spec.id}: ${base[spec.id] ?? '(new)'} -> ${head[spec.id]}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
