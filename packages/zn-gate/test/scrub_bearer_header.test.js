'use strict';
// The scrubber masks the token of an Authorization: Bearer header and keeps
// the header name and the scheme word around it. Fake values only: the token
// is built from an obvious fake prefix.
const test = require('node:test');
const assert = require('node:assert/strict');
const { findPatterns } = require('../lib/scrub/patterns');

const TOKEN = 'ZNTESTFAKE' + 'aB3dE5fG7hJ9kL1mN2pQ4rS6';

function bearerSpans(text) {
  return findPatterns(text, {}).filter((s) => s.type === 'BEARER_TOKEN');
}

// Replaces each span by a marker and keeps the rest of the text.
function mask(text, spans) {
  let out = '';
  let pos = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(pos, s.start) + '[REDACTED]';
    pos = s.end;
  }
  return out + text.slice(pos);
}

test('Authorization: Bearer masks only the token; the header name and scheme stay', () => {
  const text = 'Authorization: Bearer ' + TOKEN;
  const spans = bearerSpans(text);
  assert.equal(spans.length, 1);
  assert.equal(text.slice(spans[0].start, spans[0].end), TOKEN);
  assert.equal(mask(text, spans), 'Authorization: Bearer [REDACTED]');
});

test('curl -H form keeps the header name, the scheme and the rest of the command', () => {
  const text = 'curl -H "Authorization: Bearer ' + TOKEN + '" https://api.example.com/v1';
  const masked = mask(text, bearerSpans(text));
  assert.equal(masked, 'curl -H "Authorization: Bearer [REDACTED]" https://api.example.com/v1');
});

test('lower-case header name and scheme are masked the same way', () => {
  const text = 'authorization:bearer ' + TOKEN;
  assert.equal(mask(text, bearerSpans(text)), 'authorization:bearer [REDACTED]');
});
