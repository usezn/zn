'use strict';
// Keeps docs/api-reference.md in step with the code: every function heading must be a real export
// of the documented entry point, and every name in the documented import lines (and every public
// function of the Python package) must have a heading, so the page cannot drift from the code.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');
const docPath = path.join(repo, 'docs', 'api-reference.md');
const pyInit = path.join(repo, 'packages', 'zn-gate-py', 'src', 'zn_gate', '__init__.py');
const present = fs.existsSync(docPath) && fs.existsSync(pyInit);

// Public Python names that are deliberately not given a heading in the reference.
const PY_NOT_DOCUMENTED = new Set([
  'normalize_input', 'analyze_cloud', 'is_cloud_enabled', 'resolve_endpoint',
  'get_evidence_stats', 'export_evidence_ledger',
]);

function sections(md) {
  // Split into the Node.js and Python parts at their level-2 headings.
  const parts = md.split(/^## /m).slice(1);
  const out = {};
  for (const p of parts) {
    const title = p.split('\n', 1)[0];
    if (/^Node\.js/.test(title)) out.node = p;
    else if (/^Python/.test(title)) out.python = p;
  }
  return out;
}

function headingNames(part) {
  const names = [];
  for (const m of part.matchAll(/^### `@?([A-Za-z_][A-Za-z0-9_]*)/gm)) names.push(m[1]);
  return names;
}

function nodeImports(part) {
  // const { a, b } = require('zn-gate/lib/x');
  const out = [];
  for (const m of part.matchAll(/const \{([^}]+)\} = require\('zn-gate\/lib\/([a-z-]+)'\)/g)) {
    for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) out.push({ name: n, mod: m[2] });
  }
  return out;
}

function pyAll() {
  const src = fs.readFileSync(pyInit, 'utf8');
  const m = src.match(/__all__\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, '__all__ not found in zn_gate/__init__.py');
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function pyImportedNames(part) {
  const out = [];
  for (const m of part.matchAll(/^from zn_gate import (.+)$/gm)) {
    for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) out.push(n);
  }
  return out;
}

test('docs/api-reference.md exists and has both parts', { skip: !present && 'repository docs not in this checkout' }, () => {
  const s = sections(fs.readFileSync(docPath, 'utf8'));
  assert.ok(s.node && s.python);
});

test('Node.js: documented import names are exports and have a heading', { skip: !present && 'repository docs not in this checkout' }, () => {
  const { node } = sections(fs.readFileSync(docPath, 'utf8'));
  const headings = new Set(headingNames(node));
  const imports = nodeImports(node);
  assert.ok(imports.length >= 5, 'no import lines found');
  for (const { name, mod } of imports) {
    const exported = require(path.join('..', 'lib', mod));
    assert.strictEqual(typeof exported[name], 'function', `${name} is not exported by zn-gate/lib/${mod}`);
    assert.ok(headings.has(name), `${name} is imported in the Node.js example but has no heading`);
  }
  // Every heading is a function exported by one of the documented modules.
  const modules = [...new Set(imports.map((i) => i.mod))].map((m) => require(path.join('..', 'lib', m)));
  for (const h of headings) {
    assert.ok(modules.some((m) => typeof m[h] === 'function'), `heading ${h} is not exported by the documented modules`);
  }
});

test('Python: headings and import lines match __all__, and the public functions are documented', { skip: !present && 'repository docs not in this checkout' }, () => {
  const { python } = sections(fs.readFileSync(docPath, 'utf8'));
  const all = new Set(pyAll());
  const headings = new Set(headingNames(python));
  for (const h of headings) assert.ok(all.has(h), `heading ${h} is not in zn_gate.__all__`);
  for (const n of pyImportedNames(python)) {
    assert.ok(all.has(n), `${n} is imported in the Python example but is not in zn_gate.__all__`);
    assert.ok(headings.has(n), `${n} is imported in the Python example but has no heading`);
  }
  const code = fs.readFileSync(path.join(path.dirname(pyInit), 'rules.py'), 'utf8')
    + fs.readFileSync(path.join(path.dirname(pyInit), 'client.py'), 'utf8')
    + fs.readFileSync(path.join(path.dirname(pyInit), 'guard.py'), 'utf8')
    + fs.readFileSync(path.join(path.dirname(pyInit), 'evidence.py'), 'utf8');
  for (const n of all) {
    // Public functions (a def with this name in the package); classes, constants and the version are not headings.
    const isFunction = new RegExp(`^def ${n}\\(`, 'm').test(code);
    if (!isFunction || PY_NOT_DOCUMENTED.has(n)) continue;
    assert.ok(headings.has(n), `public function ${n} has no heading in docs/api-reference.md (add one, or list it in PY_NOT_DOCUMENTED)`);
  }
  for (const n of PY_NOT_DOCUMENTED) assert.ok(all.has(n), `${n} in PY_NOT_DOCUMENTED is no longer exported: remove it from the list`);
});
