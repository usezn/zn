'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PATCHED_MINIMUM, EOL_BELOW } = require('../lib/node-support');

// A Windows checkout may turn the line ends of these documents into CRLF; the headings and commands below are read with LF.
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const readme = lf(path.join(__dirname, '..', 'README.md'));
const guide = lf(path.join(__dirname, '..', '..', '..', 'docs', 'first-5-minutes.md'));

// The text of one section, up to the next heading.
function section(text, heading) {
  const start = text.indexOf(heading + '\n');
  assert.notEqual(start, -1, 'missing section ' + heading);
  const rest = text.slice(start + heading.length);
  const end = rest.search(/\n##? /);
  return end === -1 ? rest : rest.slice(0, end);
}

function fencedCommands(text) {
  return [...text.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => m[1].trim());
}

const readmeInstall = section(readme, '## Install');
const guideInstall = section(guide, '## 1. Install');

test('the first install command is the same text in the npm README and in the first-5-minutes guide', () => {
  const inGuide = fencedCommands(guideInstall)[0];
  assert.equal(inGuide, 'npx -y zn-gate init');
  assert.ok(readmeInstall.includes('`' + inGuide + '`'), 'README does not show: ' + inGuide);
});

test('both documents name the same patched Node.js releases as lib/node-support.js', () => {
  const list = Object.values(PATCHED_MINIMUM);
  const sentence = '(' + list.slice(0, -1).join(', ') + ', ' + list[list.length - 1] + ' or later)';
  assert.ok(readme.includes(sentence), 'README lacks ' + sentence);
  assert.ok(guide.includes(sentence), 'guide lacks ' + sentence);
});

test('both documents call the older lines end-of-life and recommend the line lib/node-support.js starts at', () => {
  const lines = [];
  for (let m = 18; m < EOL_BELOW; m += 2) lines.push(m);
  const phrase = 'Node.js ' + lines.join(' and ') + ' are end-of-life';
  const recommended = 'Node.js ' + EOL_BELOW + ' LTS is recommended';
  for (const [name, text] of [['README', readme], ['guide', guide]]) {
    assert.ok(text.includes(phrase), name + ' lacks: ' + phrase);
    assert.ok(text.includes(recommended), name + ' lacks: ' + recommended);
  }
});
