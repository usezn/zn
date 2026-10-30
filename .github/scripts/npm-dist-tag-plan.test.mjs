// Tests for npm-dist-tag-plan.mjs: run with `node --test .github/scripts/npm-dist-tag-plan.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, plan, stagedPlan, verify } from './npm-dist-tag-plan.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'npm-dist-tag-plan.mjs');

test('compare follows semver precedence', () => {
  const order = ['1.0.0-alpha.1', '1.0.0-alpha.2', '1.0.0-alpha.10', '1.0.0-beta.1', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0', '1.0.1', '1.9.0', '1.10.0', '2.0.0'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      assert.equal(compare(order[i], order[j]), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
  assert.equal(compare('1.0.0+build1', '1.0.0+build2'), 0);
  assert.ok(compare('1.14.0-rc.1', '1.13.1') > 0);
  assert.ok(compare('1.14.0', '1.14.0-rc.9') > 0);
  assert.throws(() => compare('1.0', '1.0.0'), /cannot compare/);
});

test('a newer final release moves latest', () => {
  assert.deepEqual(plan('1.14.0', { latest: '1.13.1', next: '1.14.0-rc.2' }), { tag: 'latest', latestBefore: '1.13.1' });
  assert.deepEqual(plan('2.0.0', { latest: '1.13.1' }), { tag: 'latest', latestBefore: '1.13.1' });
});

test('a final release that is not newer never moves latest back', () => {
  assert.deepEqual(plan('1.13.0', { latest: '1.14.0' }), { tag: 'release-1.13', latestBefore: '1.14.0' });
  assert.deepEqual(plan('1.14.0', { latest: '1.14.0' }), { tag: 'release-1.14', latestBefore: '1.14.0' });
  assert.deepEqual(plan('1.9.9', { latest: '1.10.0' }), { tag: 'release-1.9', latestBefore: '1.10.0' });
});

test('a final release fails closed when latest is unreadable or a prerelease', () => {
  assert.throws(() => plan('1.14.0', {}), /latest is missing/);
  assert.throws(() => plan('1.14.0', { latest: 'garbage' }), /missing or invalid/);
  assert.throws(() => plan('1.14.0', { latest: '1.15.0-rc.1' }), /prerelease/);
  assert.throws(() => plan('1.14.0', null), /unexpected/);
  assert.throws(() => plan('1.14.0', []), /unexpected/);
  assert.throws(() => plan('1.14', { latest: '1.13.1' }), /not a valid semver/);
});

test('prereleases go to their own dist-tag and never to latest', () => {
  assert.deepEqual(plan('1.14.0-rc.1', { latest: '1.13.1' }), { tag: 'next', latestBefore: '1.13.1' });
  assert.deepEqual(plan('1.14.0-rc.3', { latest: '1.13.1', next: '1.14.0-rc.2' }), { tag: 'next', latestBefore: '1.13.1' });
  assert.deepEqual(plan('1.14.0-beta.1', { latest: '1.13.1' }), { tag: 'beta', latestBefore: '1.13.1' });
  assert.deepEqual(plan('1.14.0-alpha.1', { latest: '1.13.1' }), { tag: 'alpha', latestBefore: '1.13.1' });
});

test('a prerelease that is not newer than its dist-tag fails', () => {
  assert.throws(() => plan('1.14.0-rc.1', { latest: '1.13.1', next: '1.14.0-rc.2' }), /not newer than next/);
  assert.throws(() => plan('1.14.0-rc.2', { latest: '1.13.1', next: '1.14.0-rc.2' }), /not newer than next/);
  assert.throws(() => plan('1.14.0-rc.10', { latest: '1.13.1', next: 'bad' }), /invalid version/);
  assert.throws(() => plan('1.14.0-nightly.1', { latest: '1.13.1' }), /no dist-tag for prerelease type/);
});

test('verify passes when the dist-tags are as planned', () => {
  assert.equal(verify('1.14.0', 'latest', '1.13.1', { latest: '1.14.0' }), true);
  assert.equal(verify('1.14.0-rc.1', 'next', '1.13.1', { latest: '1.13.1', next: '1.14.0-rc.1' }), true);
  assert.equal(verify('1.13.0', 'release-1.13', '1.14.0', { latest: '1.14.0', 'release-1.13': '1.13.0' }), true);
});

test('verify accepts a newer latest that landed meanwhile, and rejects a latest that moved back', () => {
  assert.equal(verify('1.14.0', 'latest', '1.13.1', { latest: '1.14.1' }), true);
  assert.throws(() => verify('1.14.0', 'latest', '1.14.0', { latest: '1.13.1' }), /backward|expected/);
  assert.throws(() => verify('1.13.0', 'release-1.13', '1.14.0', { latest: '1.13.0', 'release-1.13': '1.13.0' }), /moved backward/);
});

test('verify fails when the dist-tag is missing or points elsewhere', () => {
  assert.throws(() => verify('1.14.0', 'latest', '1.13.1', { latest: '1.13.1' }), /latest is 1.13.1, expected 1.14.0 or newer/);
  assert.throws(() => verify('1.14.0-rc.1', 'next', '1.13.1', { latest: '1.13.1' }), /points to undefined/);
  assert.throws(() => verify('1.14.0', 'latest', '1.13.1', {}), /missing or invalid/);
  assert.throws(() => verify('1.14.0', '', '1.13.1', { latest: '1.14.0' }), /no dist-tag/);
});

test('the command line prints GITHUB_OUTPUT lines and exits non-zero on a refusal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dist-tag-'));
  const f = path.join(dir, 'tags.json');
  writeFileSync(f, JSON.stringify({ latest: '1.13.1', next: '1.14.0-rc.2' }));
  const ok = spawnSync(process.execPath, [script, 'plan', '1.14.0', f], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'tag=latest\nlatest_before=1.13.1\n');
  const bad = spawnSync(process.execPath, [script, 'plan', '1.14.0-rc.1', f], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /::error::.*not newer than next/);
  const after = path.join(dir, 'after.json');
  writeFileSync(after, JSON.stringify({ latest: '1.14.0' }));
  assert.equal(spawnSync(process.execPath, [script, 'verify', '1.14.0', 'latest', '1.13.1', after], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, 'verify', '1.14.1', 'latest', '1.13.1', after], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync(process.execPath, [script, 'nonsense'], { encoding: 'utf8' }).status, 1);
});

test('a saved plan is accepted only for its version and with a dist-tag that fits it', () => {
  assert.deepEqual(stagedPlan('1.14.1', { version: '1.14.1', tag: 'latest', latest_before: '1.14.0' }), { tag: 'latest', latestBefore: '1.14.0' });
  assert.deepEqual(stagedPlan('1.13.2', { version: '1.13.2', tag: 'release-1.13', latest_before: '1.14.1' }), { tag: 'release-1.13', latestBefore: '1.14.1' });
  assert.deepEqual(stagedPlan('1.15.0-rc.1', { version: '1.15.0-rc.1', tag: 'next', latest_before: '' }), { tag: 'next', latestBefore: '' });
  assert.throws(() => stagedPlan('1.14.1', { version: '1.14.0', tag: 'latest', latest_before: '1.13.1' }), /is for 1.14.0/);
  assert.throws(() => stagedPlan('1.14.1', { version: '1.14.1', tag: 'next', latest_before: '1.14.0' }), /does not fit/);
  assert.throws(() => stagedPlan('1.14.1', { version: '1.14.1', tag: 'release-1.13', latest_before: '1.14.0' }), /does not fit/);
  assert.throws(() => stagedPlan('1.15.0-rc.1', { version: '1.15.0-rc.1', tag: 'latest', latest_before: '' }), /does not fit/);
  assert.throws(() => stagedPlan('1.14.1', { version: '1.14.1', tag: 'latest', latest_before: '' }), /no latest-before/);
  assert.throws(() => stagedPlan('1.14.1', { version: '1.14.1', tag: 'latest', latest_before: 'x' }), /not a version/);
  assert.throws(() => stagedPlan('1.14.1', null), /not an object/);
  assert.throws(() => stagedPlan('1.14.1', []), /not an object/);
});

test('plan writes the plan file and staged reads it back; a missing plan fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dist-tag-'));
  const tags = path.join(dir, 'tags.json');
  const saved = path.join(dir, 'plan.json');
  writeFileSync(tags, JSON.stringify({ latest: '1.14.0' }));
  const ok = spawnSync(process.execPath, [script, 'plan', '1.14.1', tags, saved], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')), { version: '1.14.1', tag: 'latest', latest_before: '1.14.0', sha: '' });
  const back = spawnSync(process.execPath, [script, 'staged', '1.14.1', saved], { encoding: 'utf8' });
  assert.equal(back.status, 0);
  assert.equal(back.stdout, ok.stdout);
  assert.equal(spawnSync(process.execPath, [script, 'staged', '1.14.2', saved], { encoding: 'utf8' }).status, 1);
  const missing = spawnSync(process.execPath, [script, 'staged', '1.14.1', path.join(dir, 'none.json')], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /::error::/);
});

test('verify with the published versions rejects a latest moved back below the newest final', () => {
  const versions = ['1.14.0', '1.14.1', '1.15.0-rc.1', '1.15.0'];
  // 1.14.1 was planned as latest; 1.15.0 came out; the late approval moved latest back to 1.14.1
  assert.throws(() => verify('1.14.1', 'latest', '1.14.0', { latest: '1.14.1' }, versions), /1.15.0 is published/);
  assert.equal(verify('1.14.1', 'latest', '1.14.0', { latest: '1.15.0' }, versions), true);
  assert.equal(verify('1.14.1', 'latest', '1.14.0', { latest: '1.14.1' }, ['1.14.0', '1.14.1', '1.15.0-rc.1']), true);
  assert.throws(() => verify('1.15.0-rc.2', 'next', '1.15.0', { latest: '1.14.1', next: '1.15.0-rc.2' }, versions), /moved backward|1.15.0 is published/);
  assert.throws(() => verify('1.14.1', 'latest', '1.14.0', { latest: '1.14.1' }, 42), /not a list/);
  assert.throws(() => verify('1.14.1', 'latest', '1.14.0', { latest: '1.14.1' }, 'x'), /not a list/);
  assert.throws(() => verify('1.14.1', 'latest', '1.14.0', { latest: '1.14.1' }, ''), /not a list/);
  assert.throws(() => verify('1.14.1', 'latest', '1.14.0', { latest: '1.14.1' }, ['1.13.0']), /not among the published versions/);
});

test('a saved plan must match the released commit when one is given', () => {
  const saved = { version: '1.14.1', tag: 'latest', latest_before: '1.14.0', sha: 'a'.repeat(40) };
  assert.deepEqual(stagedPlan('1.14.1', saved, 'a'.repeat(40)), { tag: 'latest', latestBefore: '1.14.0' });
  assert.throws(() => stagedPlan('1.14.1', saved, 'b'.repeat(40)), /for commit/);
  assert.throws(() => stagedPlan('1.14.1', { ...saved, sha: '' }, 'a'.repeat(40)), /for commit/);
  const dir = mkdtempSync(path.join(tmpdir(), 'dist-tag-'));
  const tags = path.join(dir, 'tags.json');
  const f = path.join(dir, 'plan.json');
  const vers = path.join(dir, 'versions.json');
  writeFileSync(tags, JSON.stringify({ latest: '1.14.0' }));
  assert.equal(spawnSync(process.execPath, [script, 'plan', '1.14.1', tags, f, 'c'.repeat(40)], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, 'staged', '1.14.1', f, 'c'.repeat(40)], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, 'staged', '1.14.1', f, 'd'.repeat(40)], { encoding: 'utf8' }).status, 1);
  writeFileSync(tags, JSON.stringify({ latest: '1.14.1' }));
  writeFileSync(vers, JSON.stringify(['1.14.0', '1.14.1', '1.15.0']));
  assert.equal(spawnSync(process.execPath, [script, 'verify', '1.14.1', 'latest', '1.14.0', tags, vers], { encoding: 'utf8' }).status, 1);
});

test('verify accepts the plain string npm prints when a package has one version', () => {
  assert.equal(verify('1.14.1', 'latest', '', { latest: '1.14.1' }, '1.14.1'), true);
  assert.throws(() => verify('1.14.1', 'latest', '', { latest: '1.14.0' }, '1.14.1'), /moved backward/);
  assert.throws(() => verify('1.14.1', 'latest', '', { latest: '1.14.1' }, 5), /not a list/);
});

test('stagedPlan checks the commit only, not which job wrote the plan', () => {
  const saved = { version: '1.14.1', tag: 'latest', latest_before: '1.14.0', sha: 'a'.repeat(40) };
  assert.deepEqual(stagedPlan('1.14.1', { ...saved, job: 'other' }, 'a'.repeat(40)), { tag: 'latest', latestBefore: '1.14.0' });
});
