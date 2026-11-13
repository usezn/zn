'use strict';

process.env.ZN_STATS = 'off';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');

const cli = require('../lib/broker/cli');
const { createFakeVault } = require('./helpers/fake_vault');
const { tempDir } = require('./helpers/tmp');

function sink() {
  const chunks = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  w.text = () => Buffer.concat(chunks).toString('utf8');
  return w;
}

test('planImport: an empty file plans nothing', () => {
  for (const text of ['', '\n', '\n\n  \n']) {
    const plan = cli.planImport(text, {});
    assert.deepEqual(plan.items, []);
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(plan.notes, []);
    assert.deepEqual(plan.parsed.entries, []);
  }
});

test('planImport: comments and blank lines are ignored and positions stay exact', () => {
  const text = '# API_KEY=commented-out-value-1\n\n   \nAPI_KEY=fake-value-123456\n# trailing note\n\n';
  const plan = cli.planImport(text, {});
  assert.equal(plan.items.length, 1);
  assert.deepEqual(plan.skipped, []);
  const it = plan.items[0];
  assert.equal(it.name, 'API_KEY');
  assert.equal(it.value, 'fake-value-123456');
  assert.equal(it.entry.lineIndex, 6); // lines alternate text and separator
  assert.equal(plan.parsed.lines[it.entry.lineIndex].slice(it.start, it.end), 'fake-value-123456');
});

test('planImport: a file with only comments and blank lines plans nothing', () => {
  const plan = cli.planImport('# one\n\n# API_KEY=fake-value-123456\n', { all: true });
  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.skipped, []);
});

test('planImport: a repeated name is planned once per line, with each line position', () => {
  const text = 'API_KEY=first-fake-value-1\nAPI_KEY=second-fake-value-2\n';
  const plan = cli.planImport(text, {});
  assert.deepEqual(plan.items.map((i) => [i.name, i.value, i.entry.lineIndex]),
    [['API_KEY', 'first-fake-value-1', 0], ['API_KEY', 'second-fake-value-2', 2]]);
});

test('planImport: names that map to the same secret name are both planned', () => {
  const plan = cli.planImport('my-api-key=first-fake-value-1\nMY_API_KEY=second-fake-value-2\n', { all: true });
  assert.deepEqual(plan.items.map((i) => i.name), ['MY_API_KEY', 'MY_API_KEY']);
});

test('planImport: does not look at the vault, so an already stored name is still planned', async (t) => {
  const dir = tempDir(t, 'zn-plan-');
  const vault = createFakeVault();
  await vault.setSecret('API_KEY', 'already-stored-fake-1', { mode: 'env' });
  const plan = cli.planImport('API_KEY=new-fake-value-123\n', {});
  assert.deepEqual(plan.items.map((i) => [i.name, i.value]), [['API_KEY', 'new-fake-value-123']]);
  assert.equal(await vault.resolve(dir, '__ZN_API_KEY__'), 'already-stored-fake-1');
});

test('secret import: a name already stored with a different value is kept unless forced', async (t) => {
  const dir = tempDir(t, 'zn-plan-');
  fs.writeFileSync(path.join(dir, '.env'), 'API_KEY=new-fake-value-123\n');
  const vault = createFakeVault();
  await vault.setSecret('API_KEY', 'already-stored-fake-1', { mode: 'env' });
  const io = { cwd: dir, home: dir, vault, stdout: sink(), stderr: sink(), human: true, confirm: async () => true };
  assert.equal(await cli.dispatch('secret', ['import'], io), 0, io.stderr.text());
  assert.match(io.stdout.text(), /skip API_KEY: a different value is already stored \(use --force to replace\)/);
  assert.match(io.stdout.text(), /Imported 0 secret\(s\)/);
  assert.equal(await vault.resolve(dir, '__ZN_API_KEY__'), 'already-stored-fake-1');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'API_KEY=new-fake-value-123\n');
});
