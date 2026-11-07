'use strict';
// Checks the shape of every changelog fragment in changelog.d (all files but README.md), as
// described in changelog.d/README.md: only the known "### " headings, bullets that start with
// "- ", continuation lines indented by two spaces, and no bullet before the first heading.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', '..', '..', 'changelog.d');
const present = fs.existsSync(dir);

const SECTIONS = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);

// Fragments that do not follow the format today (none).
const KNOWN = [];

// Returns a list of problems found in one fragment's text.
function problems(text) {
  const out = [];
  let heading = null;
  let inBullet = false;
  text.split(/\r?\n/).forEach((line, i) => {
    const at = 'line ' + (i + 1);
    if (line.trim() === '') return;
    if (line.startsWith('#')) {
      const m = /^### (.+?)\s*$/.exec(line);
      if (!m || !SECTIONS.has(m[1])) out.push(at + ': unknown heading ' + JSON.stringify(line));
      else heading = m[1];
      inBullet = false;
    } else if (line.startsWith('- ')) {
      if (heading === null) out.push(at + ': bullet before the first heading');
      inBullet = true;
    } else if (line.startsWith('  ') && inBullet) {
      // continuation of the bullet above
    } else {
      out.push(at + ': not a heading, a "- " bullet or an indented continuation: ' + JSON.stringify(line));
    }
  });
  return out;
}

test('changelog fragments follow the documented format', { skip: !present && 'changelog.d is not in this checkout' }, () => {
  const files = fs.readdirSync(dir).filter((f) => f !== 'README.md' && !KNOWN.includes(f)).sort();
  const bad = [];
  for (const f of files) {
    const p = problems(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (p.length) bad.push(f + ': ' + p.join('; '));
  }
  assert.deepStrictEqual(bad, []);
});

test('the fragment checker rejects malformed text and accepts CRLF', () => {
  assert.deepStrictEqual(problems(''), []);
  assert.deepStrictEqual(problems('### Fixed\r\n- One\r\n  more\r\n\r\n### Added\r\n- Two\r\n'), []);
  assert.strictEqual(problems('- Early\n### Fixed\n').length, 1);
  assert.ok(problems('### Fix\n- A\n').length >= 1);
  assert.strictEqual(problems('### Fixed\n* A\n').length, 1);
  assert.strictEqual(problems('### Fixed\n  indented first\n').length, 1);
});
