'use strict';
// Every value (function, class, constant) that a lib/*.d.ts file names must be an export of the
// module with the same base name. Types and interfaces are skipped: they have no runtime value.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = path.resolve(__dirname, '..', 'lib');

// Names of runtime values declared or re-exported by one declaration source.
// Re-exports return the module they come from so they can be checked there too.
function valueNames(src) {
  const own = [...src.matchAll(/^export (?:declare )?(?:async )?(?:function|class|const|let|var) (\w+)/gm)].map((m) => m[1]);
  const reexports = [];
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}\s*from\s*'([^']+)'/gm)) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean)
      .map((s) => s.split(/\s+as\s+/).pop());
    for (const name of names) reexports.push({ name, from: m[2] });
  }
  return { own, reexports };
}

test('the value parser reads functions, classes, constants and re-exports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-decl-'));
  try {
    const file = path.join(dir, 'sample.d.ts');
    fs.writeFileSync(file, [
      "export { a, b as c } from './other';",
      "export type { T } from './other';",
      'export interface Shape { x: number }',
      'export type Alias = string;',
      'export const LIMIT: number;',
      'export declare function f(): void;',
      'export function g(): void;',
      'export class K {}',
      '',
    ].join('\n'));
    const { own, reexports } = valueNames(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(own, ['LIMIT', 'f', 'g', 'K']);
    assert.deepStrictEqual(reexports, [{ name: 'a', from: './other' }, { name: 'c', from: './other' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const declarations = fs.readdirSync(lib).filter((n) => n.endsWith('.d.ts')).sort();

test('there are declaration files to check', () => {
  assert.ok(declarations.length >= 4, `found ${declarations.join(', ')}`);
});

for (const decl of declarations) {
  const base = decl.slice(0, -'.d.ts'.length);
  test(`lib/${decl} names only exports of lib/${base}.js`, () => {
    const mod = require(path.join(lib, base));
    const { own, reexports } = valueNames(fs.readFileSync(path.join(lib, decl), 'utf8'));
    for (const name of own) {
      assert.ok(name in mod, `lib/${base}.js does not export ${name}`);
    }
    for (const { name, from } of reexports) {
      assert.ok(name in mod, `lib/${base}.js does not export ${name}`);
      const target = require(path.resolve(lib, from));
      assert.ok(name in target, `${from} does not export ${name}`);
    }
  });

  test(`lib/${decl} functions, classes and constants have the declared kind`, () => {
    const mod = require(path.join(lib, base));
    const src = fs.readFileSync(path.join(lib, decl), 'utf8');
    for (const m of src.matchAll(/^export (?:declare )?(?:function|class) (\w+)/gm)) {
      assert.strictEqual(typeof mod[m[1]], 'function', `${m[1]} should be a function`);
    }
    for (const m of src.matchAll(/^export (?:declare )?const (\w+): (number|string|boolean)\b/gm)) {
      assert.strictEqual(typeof mod[m[1]], m[2], `${m[1]} should be a ${m[2]}`);
    }
  });
}
