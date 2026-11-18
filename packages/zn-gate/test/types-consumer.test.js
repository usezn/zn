'use strict';
// A consumer project (test/types-consumer/) imports every name the shipped .d.ts files declare, from each entry
// point, and is compiled with the pinned TypeScript under strict settings for two module resolution modes.
// Nothing is emitted and no network is used.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const dir = path.join(__dirname, 'types-consumer');

// Names exported by a .d.ts file, including `export type { A, B } from` and `export { a } from`.
function exportedNames(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:const|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop();
      if (n) names.add(n);
    }
  }
  return names;
}

test('package.json ships every .d.ts file the consumer project covers', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('lib/'));
  const dts = fs.readdirSync(path.join(root, 'lib')).filter((n) => n.endsWith('.d.ts')).sort();
  assert.deepStrictEqual(dts, ['client.d.ts', 'evidence.d.ts', 'guard.d.ts', 'rules.d.ts']);
});

test('the consumer uses every exported name of every .d.ts file', () => {
  const consumer = fs.readFileSync(path.join(dir, 'consumer.ts'), 'utf8');
  for (const f of fs.readdirSync(path.join(root, 'lib')).filter((n) => n.endsWith('.d.ts'))) {
    const names = exportedNames(path.join(root, 'lib', f));
    assert.ok(names.size > 0, f + ' exports nothing?');
    for (const n of names) {
      assert.ok(new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b').test(consumer), f + ': ' + n + ' is not used in consumer.ts');
    }
  }
});

for (const mode of ['node16', 'bundler']) {
  test('tsc --noEmit accepts the consumer project (moduleResolution ' + mode + ')', () => {
    assert.ok(fs.existsSync(tsc), 'typescript is not installed: run npm ci');
    const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', path.join(dir, 'tsconfig.' + mode + '.json')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  });
}
