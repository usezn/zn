'use strict';
// Writes test/fixtures/adjacent_secrets_cases.json: texts with fake keys on adjacent lines, wrapped across lines,
// or both, with the rules that must report them. Both packages read it (test/scrub_adjacent_secrets_cases.test.js
// and tests/test_adjacent_secrets_cases.py). Every key is fictitious. Run: node test/helpers/make_adjacent_secret_cases.js
const fs = require('fs');
const path = require('path');

const KEYS = {
  github: ['ghp_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5', 'secret:github_token'],
  aws: ['AKIAIOSFODNN7EXAMPLE', 'secret:aws_access_key'],
  anthropic: ['sk-ant-api03-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9', 'secret:anthropic_key'],
  huggingface: ['hf_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3j', 'secret:hf_token'],
  npm: ['npm_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5', 'secret:npm_token'],
  slack: ['xoxb-' + '123456789012-123456789012-aB3dE5gH7jK9mN1pQ3sT5vW7', 'secret:slack_token'],
  stripe: ['sk_live_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7', 'secret:stripe_key'],
  openai: ['sk-proj-' + 'EXAMPLE' + '0'.repeat(28), 'secret:openai_key'],
  pypi: ['pypi-AgE' + 'EXAMPLE' + '0'.repeat(19) + '111122233445566778899BCDFGHNOQR', 'secret:pypi_token'],
};
const WRAPPABLE = ['github', 'openai', 'pypi', 'huggingface', 'npm'];
const SEPS = { lf: '\n', crlf: '\r\n', space_lf: ' \n', lf_indent: '\n  ' };

const cases = [];
const wrap = (name, cut, sep) => KEYS[name][0].slice(0, cut) + sep + KEYS[name][0].slice(cut);
function add(id, parts, keep) {
  // parts: [{key, cut?}] joined by the separator already inside `text`
  cases.push({ id, text: parts.text, keys: parts.keys.map((k) => KEYS[k][0]), rules: parts.keys.map((k) => KEYS[k][1]).sort(), keep: keep || [] });
}

for (const n of WRAPPABLE) {
  for (const cut of [10, 14, 20]) {
    for (const [sn, sep] of Object.entries(SEPS)) add(`wrapped/${n}/${cut}/${sn}`, { text: 'token:\n' + wrap(n, cut, sep) + '\n', keys: [n] });
  }
}
for (const a of Object.keys(KEYS)) {
  for (const b of Object.keys(KEYS)) {
    for (const [sn, sep] of Object.entries(SEPS)) add(`pair/${a}+${b}/${sn}`, { text: KEYS[a][0] + sep + KEYS[b][0], keys: [a, b] });
  }
}
for (const w of WRAPPABLE) {
  for (const o of Object.keys(KEYS)) {
    add(`wrapped+key/${w}+${o}`, { text: wrap(w, 20, '\n') + '\n' + KEYS[o][0], keys: [w, o] });
    add(`key+wrapped/${o}+${w}`, { text: KEYS[o][0] + '\n' + wrap(w, 20, '\n'), keys: [o, w] });
  }
}
// Two wrapped keys one after the other: the first one open-ended (openai, pypi), or github followed by an open-ended one.
// A fixed-length key wrapped and followed by another wrapped fixed-length key, or by a long plain line, is not read apart yet.
for (const a of ['openai', 'pypi']) for (const b of WRAPPABLE) add(`wrapped+wrapped/${a}+${b}`, { text: wrap(a, 20, '\n') + '\n' + wrap(b, 20, '\n'), keys: [a, b] });
for (const b of ['openai', 'pypi']) add(`wrapped+wrapped/github+${b}`, { text: wrap('github', 20, '\n') + '\n' + wrap(b, 20, '\n'), keys: ['github', b] });

const triples = [['openai', 'pypi', 'github'], ['github', 'aws', 'slack'], ['anthropic', 'npm', 'stripe'], ['hf', 'github', 'pypi']];
for (const t of triples) {
  const ks = t.map((n) => (n === 'hf' ? 'huggingface' : n));
  for (const [sn, sep] of [['lf', '\n'], ['crlf', '\r\n']]) add(`three/${ks.join('+')}/${sn}`, { text: ks.map((k) => KEYS[k][0]).join(sep), keys: ks });
}
add('mix/openai+wrapped-github+pypi', { text: KEYS.openai[0] + '\n' + wrap('github', 20, '\n') + '\n' + KEYS.pypi[0], keys: ['openai', 'github', 'pypi'] });
add('mix/wrapped-github+aws', { text: wrap('github', 20, '\n') + '\n' + KEYS.aws[0], keys: ['github', 'aws'] });
for (const o of Object.keys(KEYS)) {
  add(`blank/${o}+github`, { text: KEYS[o][0] + '\n\n' + KEYS.github[0], keys: [o, 'github'] });
}
for (const o of ['aws', 'github', 'huggingface', 'npm', 'slack', 'stripe']) {
  for (const benign of ['plain_variable_name_here', 'see the notes below for details', 'README.md']) {
    add(`benign/${o}/${benign.slice(0, 5)}`, { text: KEYS[o][0] + '\n' + benign + '\n', keys: [o] }, [benign]);
  }
}
// The first 20 characters of a github key, then a whole aws key on the next line: the start of the github key is
// redacted too. (With a long plain line after the aws key, that start is not read as a github key yet.)
const prefix = KEYS.github[0].slice(0, 20);
for (const [sn, sep] of Object.entries(SEPS)) {
  cases.push({ id: `partial/github20+aws/${sn}`, text: prefix + sep + KEYS.aws[0], keys: [prefix, KEYS.aws[0]], rules: ['secret:aws_access_key', 'secret:github_token'], keep: [] });
}

// The file spells the first separator of two key formats as a JSON escape, so secret scanners that read the file do not
// take the fake keys for real ones; JSON.parse gives the same strings.
const json = JSON.stringify(cases, null, 1).split('xoxb-').join('xoxb\\u002d').split('sk_live_').join('sk_live\\u005f');
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'adjacent_secrets_cases.json'), json + '\n');
console.log(cases.length + ' cases');
