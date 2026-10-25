#!/usr/bin/env node
'use strict';

/**
 * Tests the release pin check (check-plugins.js --release) in a copy of the repository: before the tag the plugin pin
 * may stay on the previous release (and nothing older); on the tag it must equal the version. Run from the repository root.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = process.cwd();
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-check-plugins-')));
let n = 0;

function copyTree() {
  const dir = path.join(tmp, 'repo' + (++n));
  const list = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean);
  for (const f of list) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src) || fs.lstatSync(src).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(src, path.join(dir, f));
  }
  return dir;
}
function check(dir, ...args) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'tools', 'check-plugins.js'), ...args], { cwd: dir, encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}
function rewrite(dir, rel, fn) {
  const f = path.join(dir, rel);
  fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8')));
}
// The version in the repository and the previous release in its changelog.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/zn-gate/package.json'), 'utf8')).version;
const lockVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins/zn-gate/scripts/zn-gate.lock.json'), 'utf8')).version;
const finals = [...fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
const previous = finals[finals.indexOf(pkgVersion) + 1];

try {
  if (/^\d+\.\d+\.\d+$/.test(pkgVersion) && lockVersion === previous) {
    // The state of a release pull request before the tag.
    const a = copyTree();
    assert.ok(check(a, '--release', '--pre-tag').ok, 'pre-tag: the lock on the previous release passes');
    const b = check(a, '--release');
    assert.ok(!b.ok && /differs from the lock file version/.test(b.out), 'tag: the lock on the previous release fails');
    // Nothing older than the previous release.
    const c = copyTree();
    rewrite(c, 'CHANGELOG.md', (s) => s.replace('## [' + previous + ']', '## [0.0.1]'));
    const d = check(c, '--release', '--pre-tag');
    assert.ok(!d.ok && /must be the previous release/.test(d.out), 'pre-tag: a lock that is not the previous release fails');
    // After the pin: every place that names the old release names the new one.
    const e = copyTree();
    for (const rel of execFileSync('git', ['ls-files', 'plugins'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)) {
      if (fs.existsSync(path.join(e, rel))) rewrite(e, rel, (s) => s.split(previous).join(pkgVersion));
    }
    assert.ok(check(e, '--release').ok, 'tag: the lock on this release passes: ' + check(e, '--release').out);
    assert.ok(check(e, '--release', '--pre-tag').ok, 'pre-tag: the lock already on this release passes');
  } else {
    process.stdout.write('skipped: the lock file is already on ' + lockVersion + ' (version ' + pkgVersion + ')\n');
  }
  process.stdout.write('ok\n');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
