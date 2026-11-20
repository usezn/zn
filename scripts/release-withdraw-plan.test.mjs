// Tests for release-withdraw-plan.mjs: run with `node --test scripts/release-withdraw-plan.test.mjs`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWithdrawal, printPlan, pypiVersion } from './release-withdraw-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'release-withdraw-plan.mjs');

test('pypiVersion maps prereleases to PEP 440 and keeps finals', () => {
  assert.equal(pypiVersion('1.17.0'), '1.17.0');
  assert.equal(pypiVersion('1.17.0-rc.1'), '1.17.0rc1');
  assert.equal(pypiVersion('1.17.0-beta.2'), '1.17.0b2');
  assert.equal(pypiVersion('1.17.0-alpha.3'), '1.17.0a3');
  assert.throws(() => pypiVersion('1.17.0-rc.1.x'), /no PyPI form/);
  assert.throws(() => pypiVersion('1.17'), /not a valid semver/);
});

test('print lists only the dist-tags that point to the bad version', () => {
  const text = printPlan('1.17.0', '1.16.0', { latest: '1.17.0', next: '1.17.1-rc.1', 'release-1.17': '1.17.0' });
  assert.match(text, /npm dist-tag add zn-gate@1.16.0 latest/);
  assert.match(text, /npm dist-tag add zn-gate@1.16.0 release-1\.17/);
  assert.doesNotMatch(text, /dist-tag add zn-gate@1\.16\.0 next/);
});

test('print without dist-tags covers latest, next and the minor line, and says to check them', () => {
  const text = printPlan('1.17.0', '1.16.0');
  assert.match(text, /dist-tag add zn-gate@1.16.0 next/);
  assert.match(text, /only where the tag points to the bad version/);
});

test('print gives the deprecate, GitHub release and PyPI steps, and runs nothing', () => {
  const text = printPlan('1.17.0-rc.1', '1.16.0');
  assert.match(text, /npm deprecate zn-gate@1.17.0-rc.1 "Withdrawn: use 1.16.0 instead."/);
  assert.match(text, /gh release edit v1.17.0-rc.1 --draft=true -R usezn\/zn/);
  assert.match(text, /gh release edit v1.16.0 --latest -R usezn\/zn/);
  assert.match(text, /yank zn-gate 1.17.0rc1 on pypi.org/);
  assert.match(text, /Nothing here is run/);
});

test('print refuses an invalid or identical pair', () => {
  assert.throws(() => printPlan('1.17', '1.16.0'), /bad is not a valid semver/);
  assert.throws(() => printPlan('1.17.0', 'x'), /good is not a valid semver/);
  assert.throws(() => printPlan('1.17.0', '1.17.0'), /same version/);
  assert.throws(() => printPlan('1.17.0', '1.16.0', []), /not an object/);
});

test('the helper cannot execute anything: it does not load a process module', () => {
  const src = readFileSync(script, 'utf8');
  assert.doesNotMatch(src, /child_process|execFile|spawn\(|exec\(/);
});

test('check passes once the tags, the deprecation and the published version are in place', () => {
  const r = checkWithdrawal({
    bad: '1.17.0',
    good: '1.16.0',
    tags: { latest: '1.16.0', next: '1.16.0' },
    view: { version: '1.17.0', deprecated: 'Withdrawn: use 1.16.0 instead.' },
    versions: ['1.16.0', '1.17.0'],
  });
  assert.ok(r.every((x) => x.level === 'OK'), JSON.stringify(r));
});

test('check reports PENDING for a tag still on the bad version and for a missing deprecation', () => {
  const r = checkWithdrawal({ bad: '1.17.0', good: '1.16.0', tags: { latest: '1.17.0' }, view: { version: '1.17.0' }, versions: ['1.16.0', '1.17.0'] });
  assert.ok(r.some((x) => x.level === 'PENDING' && /latest still points to 1.17.0/.test(x.text)));
  assert.ok(r.some((x) => x.level === 'PENDING' && /not deprecated yet/.test(x.text)));
  assert.ok(!r.some((x) => x.level === 'FAIL'));
});

test('check fails when the good version is not on npm or latest would be a prerelease', () => {
  const missing = checkWithdrawal({ bad: '1.17.0', good: '1.16.0', tags: { latest: '1.17.0' }, versions: ['1.17.0'] });
  assert.ok(missing.some((x) => x.level === 'FAIL' && /not published/.test(x.text)));
  const pre = checkWithdrawal({ bad: '1.17.0', good: '1.17.1-rc.1', tags: { latest: '1.17.0' }, versions: ['1.17.1-rc.1', '1.17.0'] });
  assert.ok(pre.some((x) => x.level === 'FAIL' && /prerelease/.test(x.text)));
});

test('check fails when the view is for another version or the versions list is malformed', () => {
  const other = checkWithdrawal({ bad: '1.17.0', good: '1.16.0', tags: {}, view: { version: '1.16.0' } });
  assert.ok(other.some((x) => x.level === 'FAIL' && /view is for 1.16.0/.test(x.text)));
  const bad = checkWithdrawal({ bad: '1.17.0', good: '1.16.0', tags: {}, versions: [1, 2] });
  assert.ok(bad.some((x) => x.level === 'FAIL' && /not a list/.test(x.text)));
});

test('check accepts npm printing a single version as a plain string', () => {
  const r = checkWithdrawal({ bad: '1.17.0', good: '1.16.0', tags: {}, versions: '1.16.0' });
  assert.ok(r.some((x) => x.level === 'OK' && /good 1.16.0 is published/.test(x.text)));
});

test('the command line exits 1 on a FAIL and 0 on PENDING, and 1 on usage errors', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'withdraw-'));
  const tags = path.join(dir, 'tags.json');
  const view = path.join(dir, 'view.json');
  const versions = path.join(dir, 'versions.json');
  writeFileSync(tags, JSON.stringify({ latest: '1.17.0' }));
  writeFileSync(view, JSON.stringify({ version: '1.17.0' }));
  writeFileSync(versions, JSON.stringify(['1.16.0', '1.17.0']));

  const pending = spawnSync(process.execPath, [script, 'check', '1.17.0', '1.16.0', tags, view, versions], { encoding: 'utf8' });
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.stdout, /PENDING dist-tag latest still points to 1.17.0/);

  writeFileSync(versions, JSON.stringify(['1.17.0']));
  const fail = spawnSync(process.execPath, [script, 'check', '1.17.0', '1.16.0', tags, view, versions], { encoding: 'utf8' });
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /FAIL good 1.16.0 is not published/);

  const usage = spawnSync(process.execPath, [script, 'publish', '1.17.0'], { encoding: 'utf8' });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage:/);

  const printed = spawnSync(process.execPath, [script, 'print', '1.17.0', '1.16.0', tags], { encoding: 'utf8' });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /npm dist-tag add zn-gate@1.16.0 latest/);
});
