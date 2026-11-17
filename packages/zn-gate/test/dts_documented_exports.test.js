'use strict';
// Every runtime export that docs/api-reference.md documents for the Node entries (lib/client, lib/rules,
// lib/evidence) must also be declared in the matching .d.ts as a value. The other tests check the reverse
// direction (declared -> runtime); this one catches a documented export that has no declaration.
// The check compiles a generated file with the pinned TypeScript compiler; nothing is emitted.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const apiDoc = path.resolve(root, '..', '..', 'docs', 'api-reference.md');

// { 'lib/client': Set(names) } from the Node section of the API reference.
function documentedExports(md) {
  const start = md.indexOf('## Node.js (`zn-gate`)');
  const end = md.indexOf('## Python (`zn-gate`)');
  assert.ok(start >= 0 && end > start, 'the Node.js section of the API reference was not found');
  const section = md.slice(start, end);
  const out = {};
  const add = (mod, name) => { (out[mod] = out[mod] || new Set()).add(name); };
  for (const m of section.matchAll(/const \{([^}]+)\} = require\('zn-gate\/(lib\/\w+)'\);/g)) {
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) add(m[2], name);
  }
  // "- `NAME` (`zn-gate/lib/client` and `zn-gate/lib/rules`): ..." in the Constants list.
  for (const m of section.matchAll(/^- `([A-Z][A-Z0-9_]+)` \(([^)]*)\)/gm)) {
    for (const p of m[2].matchAll(/`zn-gate\/(lib\/\w+)`/g)) add(p[1], m[1]);
  }
  return out;
}

test('the documented-exports reader finds the require lines and the constants', () => {
  const md = [
    '## Node.js (`zn-gate`)',
    "const { a, b } = require('zn-gate/lib/client');",
    "const { c } = require('zn-gate/lib/rules');",
    '- `LIMIT` (`zn-gate/lib/client` and `zn-gate/lib/rules`): one.',
    '## Python (`zn-gate`)',
    "const { z } = require('zn-gate/lib/client');",
  ].join('\n');
  const got = documentedExports(md);
  assert.deepStrictEqual([...got['lib/client']].sort(), ['LIMIT', 'a', 'b']);
  assert.deepStrictEqual([...got['lib/rules']].sort(), ['LIMIT', 'c']);
});

test('every documented Node export exists at runtime and is declared as a value in its .d.ts', () => {
  assert.ok(fs.existsSync(tsc), 'typescript is not installed: run npm ci');
  const docs = documentedExports(fs.readFileSync(apiDoc, 'utf8'));
  for (const mod of ['lib/client', 'lib/rules', 'lib/evidence']) {
    assert.ok(docs[mod] && docs[mod].size > 0, `no documented exports found for ${mod}`);
  }
  assert.ok(docs['lib/client'].has('checkCommand'), 'the reader should see checkCommand');

  for (const [mod, names] of Object.entries(docs)) {
    const runtime = require(path.join(root, mod));
    for (const n of names) assert.ok(n in runtime, `${mod}.js does not export the documented name ${n}`);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-dts-docs-'));
  try {
    const lines = [];
    let i = 0;
    for (const [mod, names] of Object.entries(docs)) {
      const list = [...names].sort();
      const alias = list.map((n) => `${n} as ${n}${i}`).join(', ');
      lines.push(`import { ${alias} } from ${JSON.stringify(path.join(root, mod).replace(/\\/g, '/'))};`);
      lines.push(`void [${list.map((n) => n + i).join(', ')}];`);
      i += 1;
    }
    fs.writeFileSync(path.join(dir, 'documented.ts'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'node16', moduleResolution: 'node16', strict: true, noEmit: true,
        skipLibCheck: false, types: [], lib: ['ES2020'] },
      files: ['documented.ts'],
    }));
    const r = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, 'a documented export is missing from its .d.ts:\n' + (r.stdout || '') + (r.stderr || ''));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
