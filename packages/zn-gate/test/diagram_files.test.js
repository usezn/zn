'use strict';
// Checks the diagram files in docs/diagrams: every .excalidraw source is valid JSON and has its
// four SVG variants, and the SVG files carry no script and no link other than the XML namespace.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', '..', '..', 'docs', 'diagrams');
const present = fs.existsSync(dir);
const names = present
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.excalidraw')).map((f) => f.slice(0, -'.excalidraw'.length))
  : [];
const SUFFIXES = ['light', 'dark', 'animated-light', 'animated-dark'];

test('docs/diagrams has diagram sources', { skip: !present && 'docs not in checkout' }, () => {
  assert.ok(names.length > 0);
});

for (const name of names) {
  test(`${name}.excalidraw parses as JSON`, { skip: !present && 'docs not in checkout' }, () => {
    JSON.parse(fs.readFileSync(path.join(dir, `${name}.excalidraw`), 'utf8'));
  });

  for (const suffix of SUFFIXES) {
    const file = `${name}-${suffix}.svg`;
    test(`${file} is a clean SVG`, { skip: !present && 'docs not in checkout' }, () => {
      const full = path.join(dir, file);
      assert.ok(fs.existsSync(full), `${file} is missing`);
      const svg = fs.readFileSync(full, 'utf8');
      assert.ok(/^\s*(<\?xml[^>]*\?>\s*)?<svg/.test(svg), 'must start with <svg');
      assert.ok(!/<script/i.test(svg), 'must not contain a script tag');
      assert.ok(!/<a[\s>]/i.test(svg), 'must not contain anchors');
      const urls = svg.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]*/gi) || [];
      for (const u of urls) {
        assert.ok(/^http:\/\/www\.w3\.org\//.test(u), `unexpected link: ${u}`);
      }
      // Links to elements inside the same file (href="#id") are fine; nothing else is.
      for (const m of svg.matchAll(/\bhref\s*=\s*"([^"]*)"/gi)) {
        assert.ok(m[1].startsWith('#'), `unexpected href: ${m[1]}`);
      }
      assert.strictEqual(/@keyframes/.test(svg), suffix.startsWith('animated'),
        suffix.startsWith('animated') ? 'animated SVG needs @keyframes' : 'static SVG must not have @keyframes');
    });
  }
}
