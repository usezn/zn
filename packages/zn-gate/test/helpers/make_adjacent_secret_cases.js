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
// Two wrapped keys one after the other, whatever their kind.
for (const a of WRAPPABLE) for (const b of WRAPPABLE) add(`wrapped+wrapped/${a}+${b}`, { text: wrap(a, 20, '\n') + '\n' + wrap(b, 20, '\n'), keys: [a, b] });
// A wrapped key between plain lines and next to a short plain line. The body of an open-ended key (openai, pypi) can
// run on into a plain token with an underscore, so that line is not asserted to stay for those two (no key is left).
const PLAIN = ['plain_variable_name_here', 'see the notes below for details', 'a short note', 'README.md'];
const OPEN_ENDED = ['openai', 'pypi'];
for (const w of WRAPPABLE) {
  PLAIN.forEach((plain, i) => {
    const other = PLAIN[(i + 1) % PLAIN.length];
    const kept = (...lines) => (OPEN_ENDED.includes(w) ? lines.filter((l) => !l.includes('_')) : lines);
    add(`wrapped+plain/${w}/${i}`, { text: wrap(w, 20, '\n') + '\n' + plain + '\n', keys: [w] }, kept(plain));
    add(`plain+wrapped/${w}/${i}`, { text: plain + '\n' + wrap(w, 20, '\n') + '\n', keys: [w] }, [plain]);
    add(`plain+wrapped+plain/${w}/${i}`, { text: other + '\n' + wrap(w, 20, '\n') + '\n' + plain + '\n', keys: [w] }, kept(plain, other).concat(OPEN_ENDED.includes(w) ? [] : []));
  });
}
// Three wrapped keys, and a wrapped key between two keys.
for (const w of WRAPPABLE) add(`wrapped x3/${w}`, { text: [wrap(w, 20, '\n'), wrap(w, 20, '\n'), wrap(w, 20, '\n')].join('\n'), keys: [w, w, w] });
add('wrapped between keys', { text: KEYS.aws[0] + '\n' + wrap('github', 20, '\n') + '\n' + KEYS.slack[0], keys: ['aws', 'github', 'slack'] });

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
// redacted too, with or without a plain line after the aws key.
const prefix = KEYS.github[0].slice(0, 20);
for (const [sn, sep] of Object.entries(SEPS)) {
  cases.push({ id: `partial/github20+aws/${sn}`, text: prefix + sep + KEYS.aws[0], keys: [prefix, KEYS.aws[0]], rules: ['secret:aws_access_key', 'secret:github_token'], keep: [] });
}

cases.push({ id: 'partial/github20+aws+benign', text: prefix + '\n' + KEYS.aws[0] + '\nplain_variable_name_here\n', keys: [prefix, KEYS.aws[0]], rules: ['secret:aws_access_key', 'secret:github_token'], keep: ['plain_variable_name_here'] });

// Keys with no fixed length (OpenAI, Anthropic, PyPI) cut wherever a line ends: the last piece can be shorter than a
// joinable line, and the next line can be another key or any plain text. The piece after the cut is redacted with the
// key whatever it looks like (a one-word line right after such a key goes with it); a line with more text stays.
const OPEN = {
  openai_legacy: ['sk-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ', 'secret:openai_key'],
  openai_proj: ['sk-proj-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ0123456789', 'secret:openai_key'],
  anthropic_long: ['sk-ant-api03-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ0123456789AB', 'secret:anthropic_key'],
  pypi_long: ['pypi-AgEIcHlwaS5vcmc' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ0123456789ABCDEF', 'secret:pypi_token'],
};
const MARK = { 'secret:openai_key': '[REDACTED_OPENAI_KEY]', 'secret:anthropic_key': '[REDACTED_ANTHROPIC_KEY]', 'secret:pypi_token': '[REDACTED_PYPI_TOKEN]', 'secret:github_token': '[REDACTED_GITHUB_TOKEN]' };
const OPEN_NEXT = [
  ['word_line', 'hello world', [], 'hello world'],
  ['code_line', 'const x = 1;', [], 'const x = 1;'],
  ['github_key', KEYS.github[0], ['github'], null],
  ['openai_key', KEYS.openai[0], ['openai'], null],
  ['pypi_key', KEYS.pypi[0], ['pypi'], null],
];
for (const [name, [key, rule]] of Object.entries(OPEN)) {
  for (const back of [1, 3, 5, 9, 10, 15, 30]) {
    const cut = key.length - back;
    for (const [sn, sep] of Object.entries(SEPS)) {
      for (const [nn, next, nextKeys, kept] of OPEN_NEXT) {
        const rules = [rule].concat(nextKeys.map((k) => KEYS[k][1])).sort();
        const lines = key.slice(0, cut) + sep + key.slice(cut) + '\n' + next + '\n';
        const out = 'token:\n' + MARK[rule] + '\n' + (kept ? kept : MARK[KEYS[nextKeys[0]][1]]) + '\n';
        cases.push({ id: `open-ended/${name}/tail${back}/${sn}/${nn}`, text: 'token:\n' + lines, keys: [key].concat(nextKeys.map((k) => KEYS[k][0])), rules, keep: kept ? [kept] : [], out });
      }
    }
  }
  // The key and its rest in quotes, a CRLF text, and the end of the text right after the rest.
  const cut = key.length - 4;
  cases.push({ id: `open-ended/${name}/quoted`, text: 'api = "' + key.slice(0, cut) + '\n' + key.slice(cut) + '"\nprint(1)\n', keys: [key], rules: [rule], keep: ['print(1)'], out: 'api = "' + MARK[rule] + '"\nprint(1)\n' });
  cases.push({ id: `open-ended/${name}/crlf-text`, text: 'k=' + key.slice(0, cut) + '\r\n' + key.slice(cut) + '\r\nnext line here\r\n', keys: [key], rules: [rule], keep: ['next line here'], out: 'k=' + MARK[rule] + '\r\nnext line here\r\n' });
  cases.push({ id: `open-ended/${name}/end-of-text`, text: key.slice(0, cut) + '\n' + key.slice(cut), keys: [key], rules: [rule], keep: [], out: MARK[rule] });
}
// A complete key followed by a line with more text, or an identifier that is only long, is not touched.
cases.push({ id: 'open-ended/complete+prose', text: OPEN.openai_proj[0] + '\nsee the notes below\n', keys: [OPEN.openai_proj[0]], rules: ['secret:openai_key'], keep: ['see the notes below'] });

// The file spells the first separator of two key formats as a JSON escape, so secret scanners that read the file do not
// take the fake keys for real ones; JSON.parse gives the same strings.
const json = JSON.stringify(cases, null, 1).split('xoxb-').join('xoxb\\u002d').split('sk_live_').join('sk_live\\u005f');
fs.writeFileSync(path.join(__dirname, '..', 'fixtures', 'adjacent_secrets_cases.json'), json + '\n');
console.log(cases.length + ' cases');
