'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { advisoriesFor, advisoryLine, TABLE } = require('../lib/agents/advisories');
const { toJson, report } = require('../lib/check');

test('a version in range warns, with the fixed version and the link', () => {
  const a = advisoriesFor('claude-code', '2.0.64');
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].fixed, '2.0.65');
  const line = advisoryLine(a[0], 'Claude Code');
  assert.match(line, /Claude Code 2\.0\.64/);
  assert.match(line, /2\.0\.65/);
  assert.match(line, /https:\/\/github\.com\/advisories\/GHSA-jh7p-qr78-84p7/);
});

test('the upper bound is inclusive when the advisory says "or below"', () => {
  assert.strictEqual(advisoriesFor('codex', '0.23.0').length, 1);
  assert.strictEqual(advisoriesFor('codex', '0.24.0').length, 0);
  assert.match(advisoryLine(advisoriesFor('codex', '0.23.0')[0], 'Codex CLI'), /no fixed version/);
});

test('a fixed version is silent', () => {
  assert.deepStrictEqual(advisoriesFor('claude-code', '2.0.65'), []);
  assert.deepStrictEqual(advisoriesFor('claude-code', '3.1.0'), []);
});

test('an unknown or unparseable version is silent', () => {
  for (const v of [null, undefined, '', 'unknown', 'abc', '2.0']) assert.deepStrictEqual(advisoriesFor('claude-code', v), []);
  assert.deepStrictEqual(advisoriesFor('no-such-agent', '1.0.0'), []);
});

test('check --json has the advisories field, shaped', () => {
  const adv = advisoriesFor('claude-code', '2.0.0');
  const results = [{ id: 'claude-code', name: 'Claude Code', state: 'protected', message: 'm', notes: [], advisories: adv }, { id: 'codex', name: 'Codex CLI', state: 'not-set-up', found: false, notes: [] }];
  const j = toJson({ results, removed: true, warnings: [] }, { home: '/h' });
  assert.deepStrictEqual(Object.keys(j.agents[0].advisories[0]).sort(), ['cve', 'fixed_version', 'id', 'installed_version', 'published', 'source', 'url']);
  assert.strictEqual(j.agents[0].advisories[0].installed_version, '2.0.0');
  assert.deepStrictEqual(j.agents[1].advisories, []);
  assert.strictEqual(j.exit_code, 0);
});

test('the text report prints the note and the exit code does not change', () => {
  const adv = advisoriesFor('claude-code', '2.0.0');
  const results = [{ id: 'claude-code', name: 'Claude Code', state: 'protected', message: 'm', notes: [], advisories: adv }];
  let out = '';
  const code = report({ results, removed: true, warnings: [] }, (s) => { out += s; });
  assert.strictEqual(code, 0);
  assert.match(out, /Note: Claude Code 2\.0\.0 is in the affected range/);
});

test('table schema', () => {
  assert.ok(TABLE.length > 0);
  for (const e of TABLE) {
    for (const k of ['agent', 'id', 'affected', 'url', 'published', 'source']) assert.ok(e[k], `${e.id} lacks ${k}`);
    assert.ok('fixed' in e, `${e.id} lacks fixed`);
    assert.match(e.id, /^GHSA(-[2-9cfghjmpqrvwx]{4}){3}$/);
    assert.match(e.url, /^https:\/\/github\.com\/(advisories\/GHSA-|[\w.-]+\/[\w.-]+\/security\/advisories\/GHSA-)/);
    assert.match(e.published, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Object.keys(e.affected).every((k) => k === 'below' || k === 'atOrBelow'));
    assert.ok(e.fixed === null || /^\d+\.\d+\.\d+$/.test(e.fixed));
  }
});
