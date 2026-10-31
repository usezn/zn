'use strict';

// A rules file says its version twice: in the header comment ("RULES_VERSION: x") and in the constant.
// They drifted apart once; this keeps every header in lib/ equal to its constant.

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const LIB = path.join(__dirname, '..', 'lib');

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('every *_RULES_VERSION header comment in lib/ equals its constant', () => {
  let checked = 0;
  for (const file of jsFiles(LIB)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*\*\s*([A-Z_]*RULES_VERSION):\s*(\S+)/gm)) {
      const [, name, header] = m;
      const c = src.match(new RegExp(`const ${name} = '([^']+)'`));
      if (!c) continue;
      checked++;
      assert.equal(header, c[1], `${path.relative(LIB, file)}: header says ${name} ${header}, the constant is ${c[1]}`);
    }
  }
  assert.ok(checked > 0, 'no RULES_VERSION header found in lib/');
});
