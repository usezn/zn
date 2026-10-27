// Tests for npm-dist-tag-plan.mjs: run with `node --test .github/scripts/npm-dist-tag-plan.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, plan, verify } from './npm-dist-tag-plan.mjs';

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
