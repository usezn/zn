#!/usr/bin/env node
// Fails when an input of action.yml has no description, or an empty one. The Marketplace page and the
// action's documentation show each input's description; an input without one is blank there.
//
//   node .github/scripts/check-action-inputs.mjs [action-file]     default: action.yml
//
// The check reads the file line by line (inputs are the keys indented by two spaces under the top-level
// `inputs:`, their fields by four spaces), so it needs no YAML library. It fails on an action whose `inputs:`
// has no input it can read, so a change of indentation cannot switch it off.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Returns { inputs, problems } for one action.yml text; problems are [{ input, reason }]. */
export function checkText(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const problems = [];
  let inInputs = false;
  let hasInputsKey = false;
  let inputs = 0;
  let cur = null;
  const flush = () => {
    if (cur && !cur.described) problems.push({ input: cur.name, reason: cur.reason });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^inputs:\s*(#.*)?$/.test(line)) { inInputs = true; hasInputsKey = true; continue; }
    if (inInputs && /^\S/.test(line) && !line.startsWith('#')) { flush(); inInputs = false; }
    if (!inInputs) continue;
    const key = line.match(/^ {2}(["']?)([A-Za-z0-9_-]+)\1:\s*(#.*)?$/);
    if (key) { flush(); inputs++; cur = { name: key[2], described: false, reason: 'no description' }; continue; }
    if (!cur) continue;
    const field = line.match(/^ {4}description:[ \t]*(.*)$/);
    if (!field) continue;
    const value = field[1].trim();
    if (value === '' || /^[|>][-+0-9]*(\s+#.*)?$/.test(value)) {
      // A block scalar (or a value on the following lines): look for text indented deeper than the key.
      let found = false;
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (next.trim() === '') continue;
        if (!/^ {5,}\S/.test(next)) break;
        found = true;
        break;
      }
      cur.described = found;
      cur.reason = 'empty description';
    } else {
      const unquoted = value.replace(/^(["'])(.*)\1$/, '$2').trim();
      cur.described = unquoted !== '';
      cur.reason = 'empty description';
    }
  }
  flush();
  if (hasInputsKey && inputs === 0) {
    problems.push({ input: '(file)', reason: 'has "inputs:" but no input could be read (two-space indent expected)' });
  }
  return { inputs, problems };
}

function main(argv) {
  const file = argv[0] || 'action.yml';
  const { inputs, problems } = checkText(fs.readFileSync(file, 'utf8'));
  if (problems.length) {
    for (const p of problems) console.error(`${file}: input "${p.input}": ${p.reason}`);
    console.error('\nAdd a `description:` to each input listed above (one plain sentence saying what the input does).');
    return 1;
  }
  console.log(`action inputs OK: ${inputs} input(s) of ${file} have a description`);
  return 0;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-action-inputs: ' + e.message); process.exitCode = 1; }
}
