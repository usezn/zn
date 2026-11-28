'use strict';
// A fictitious key split in pieces by one of many separators (tabs, no-break spaces, Unicode line separators, line
// breaks, quoted string pieces, escaped break sequences, zero-width characters) leaves no readable run of 8 or more of
// its characters, and ordinary text with quotes or odd spaces is left as it was. Same cases as
// tests/test_scrubber_break_classes.py in the Python package.
const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSecrets } = require('../lib/rules');

const KEYS = {
  github: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  aws: 'AKIA' + 'Z7Q2M9X4B6C1D8E3',
  hex: 'dop_v1_' + '0123456789abcdef'.repeat(4),
  openai: 'sk-proj-' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5nP7rT9uVwXyZ',
};
const SEPARATORS = {
  tab: '\t',
  nbsp: '\u00a0',
  line_separator: '\u2028',
  paragraph_separator: '\u2029',
  line_feed: '\n',
  crlf: '\r\n',
  space_line_feed: ' \n',
  indented_line_feed: '\n    ',
  backslash_line_feed: ' \\\n',
  double_quotes_plus: '"+"',
  double_quotes_space: '" "',
  single_quotes_plus: "' + '",
  quoted_lines: '"\n"',
  escaped_n: '\\n',
  escaped_crlf: '\\r\\n',
  escaped_t: '\\t',
  zero_width: '\u200b',
};
const WIDTHS = [8, 9, 13, 20, 40];
const CONTEXTS = [['', ''], ['token: ', '\nnext line\n'], ['{"k": "', '", "n": 3}']];
const STRIP = new RegExp('\\\\[nrt]|[\\s"\'+\\\\`\\u2028\\u2029\\u00a0\\u200b\\u200c\\u200d\\ufeff]', 'g');

function wrap(key, width, sep) {
  const parts = [];
  for (let i = 0; i < key.length; i += width) parts.push(key.slice(i, i + width));
  return parts.join(sep);
}

function readableRun(secret, out) {
  const flat = out.replace(STRIP, '');
  for (let i = 0; i + 8 <= secret.length; i++) {
    if (flat.includes(secret.slice(i, i + 8))) return secret.slice(i, i + 8);
  }
  return '';
}

for (const [sepName, sep] of Object.entries(SEPARATORS)) {
  test(`a key split by ${sepName} leaves no readable part`, () => {
    for (const [name, key] of Object.entries(KEYS)) {
      for (const width of WIDTHS) {
        for (const [pre, post] of CONTEXTS) {
          const text = pre + wrap(key, width, sep) + post;
          const run = readableRun(key, redactSecrets(text).sanitized);
          assert.equal(run, '', `${name} width ${width} ${JSON.stringify(pre)}: readable ${JSON.stringify(run)}`);
        }
      }
    }
  });
}

test('text with quoted words, tabs and odd spaces is left as it was', () => {
  const texts = [
    '"hello world" "foo bar"',
    '{"a": "some words here", "b": "other words here"}',
    "echo 'one two three' 'four five six'",
    'const a = "abcdefghij" + "klmnopqr";',
    'name\tvalue\tother column\tlast',
    'plain\u00a0text with a no-break space\u00a0inside it',
    'line one\\nline two\\nline three',
    'path C:\\temp\\new folder\\table.txt',
    'quoted "abcdefghijkl" and then "mnop"',
  ];
  for (const t of texts) assert.equal(redactSecrets(t).sanitized, t, JSON.stringify(t));
});
