'use strict';
// More cases for the rule in docs_index_complete.test.js: every Markdown page under docs/,
// including docs/editors/ and docs/examples/, is linked from the docs index (docs/README.md),
// directly or through an index page (a README.md inside docs/) that the docs index links
// directly, or is on a short list of pages left out on purpose, each with its reason.
// The reachability walk below is the same as the one in docs_index_complete.test.js; the cases
// here cover the link forms and folders that file does not test.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..', '..');
const docs = path.join(repo, 'docs');

// Pages left out of the docs index on purpose, relative to docs/, each as [name, reason].
// Today every page is linked, so the list is empty.
const LEFT_OUT = new Map([]);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

function stripCode(md) {
  return md.replace(/^(```|~~~)[\s\S]*?^\1.*$/gm, '').replace(/`[^`\n]*`/g, '');
}

function linkedPages(file) {
  const text = stripCode(fs.readFileSync(file, 'utf8'));
  const targets = [];
  const inline = /\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const refdef = /^\s{0,3}\[[^\]\n]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/gm;
  for (const re of [inline, refdef]) {
    let m;
    while ((m = re.exec(text))) {
      let target = m[1];
      if (target.startsWith('#') || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      target = target.split('#')[0].split('?')[0];
      if (!target.endsWith('.md')) continue;
      try { target = decodeURIComponent(target); } catch { /* keep as written */ }
      targets.push(path.resolve(path.dirname(file), target));
    }
  }
  return targets;
}

function unreachable(docsDir) {
  const root = path.resolve(docsDir);
  const insideDocs = (f) => {
    const rel = path.relative(root, f);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const start = path.join(root, 'README.md');
  const reached = new Set([start]);
  const addLinks = (file, follow) => {
    const found = [];
    for (const t of linkedPages(file)) {
      if (!insideDocs(t) || !fs.existsSync(t)) continue;
      reached.add(t);
      found.push(t);
    }
    return follow ? found.filter((t) => path.basename(t) === 'README.md') : [];
  };
  for (const index of addLinks(start, true)) addLinks(index, false);
  return walk(root)
    .filter((f) => !reached.has(f))
    .map((f) => path.relative(root, f).split(path.sep).join('/'));
}

function withDocs(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-covers-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), body);
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const folder of ['editors', 'examples']) {
  test(`the docs index links docs/${folder}/README.md directly`, () => {
    const direct = linkedPages(path.join(docs, 'README.md'));
    assert.ok(direct.includes(path.join(docs, folder, 'README.md')),
      `docs/README.md has no link to ${folder}/README.md`);
  });

  test(`every page under docs/${folder}/ is linked or left out with a reason`, () => {
    const pages = walk(path.join(docs, folder));
    assert.ok(pages.length > 1, `docs/${folder}/ has pages besides its README.md`);
    const missing = unreachable(docs)
      .filter((p) => p.startsWith(folder + '/'))
      .filter((p) => !LEFT_OUT.has(p));
    assert.deepStrictEqual(missing, [], 'not linked from the docs index: ' + missing.join(', '));
  });
}

test('every page left out on purpose has a reason next to it, exists and is still unlinked', () => {
  const unlinked = new Set(unreachable(docs));
  for (const [p, reason] of LEFT_OUT) {
    assert.strictEqual(typeof reason, 'string', p + ' needs a reason');
    assert.ok(reason.trim().length > 0, p + ' needs a reason');
    assert.ok(fs.existsSync(path.join(docs, p)), p + ' does not exist');
    assert.ok(unlinked.has(p), p + ' is linked now: take it off the list');
  }
});

test('reference-style links count as links', () => {
  withDocs({
    'README.md': '# Docs\n\nSee [the guide][g].\n\n[g]: guide.md\n',
    'guide.md': '# Guide\n',
  }, (dir) => assert.deepStrictEqual(unreachable(dir), []));
});

test('links with an anchor, a title, angle brackets or percent-encoding count', () => {
  withDocs({
    'README.md': '# Docs\n\n- [A](a.md#part)\n- [B](b.md "Title")\n- [C](<c.md>)\n- [D](two%20words.md)\n',
    'a.md': '# A\n',
    'b.md': '# B\n',
    'c.md': '# C\n',
    'two words.md': '# D\n',
  }, (dir) => assert.deepStrictEqual(unreachable(dir), []));
});

test('a link inside a tilde fence or inline code does not count', () => {
  withDocs({
    'README.md': '# Docs\n\n~~~\n[A](a.md)\n~~~\n\nUse `[B](b.md)` as a pattern.\n',
    'a.md': '# A\n',
    'b.md': '# B\n',
  }, (dir) => assert.deepStrictEqual(unreachable(dir).sort(), ['a.md', 'b.md']));
});

test('web links, absolute paths and links to missing files are ignored', () => {
  withDocs({
    'README.md': '# Docs\n\n- [Web](https://example.com/a.md)\n- [Abs](/a.md)\n- [Gone](gone.md)\n',
    'a.md': '# A\n',
  }, (dir) => assert.deepStrictEqual(unreachable(dir), ['a.md']));
});

test('files that are not Markdown are not pages', () => {
  withDocs({
    'README.md': '# Docs\n',
    'diagrams/picture.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
    'diagrams/NOTICE.md': '# Notice\n',
  }, (dir) => assert.deepStrictEqual(unreachable(dir), ['diagrams/NOTICE.md']));
});

test('an index page linked with an anchor still passes the walk on', () => {
  withDocs({
    'README.md': '# Docs\n\n[Editors](editors/README.md#setup)\n',
    'editors/README.md': '# Editors\n\n[One](one.md)\n',
    'editors/one.md': '# One\n',
  }, (dir) => assert.deepStrictEqual(unreachable(dir), []));
});

test('an index page can make a page in another folder reachable', () => {
  withDocs({
    'README.md': '# Docs\n\n[Examples](examples/README.md)\n',
    'examples/README.md': '# Examples\n\n[Editor page](../editors/one.md)\n',
    'editors/one.md': '# One\n',
    'editors/two.md': '# Two\n',
  }, (dir) => assert.deepStrictEqual(unreachable(dir), ['editors/two.md']));
});

test('a README.md in a subfolder that nobody links is reported, and so are its pages', () => {
  withDocs({
    'README.md': '# Docs\n',
    'examples/README.md': '# Examples\n\n[One](one.md)\n',
    'examples/one.md': '# One\n',
  }, (dir) => assert.deepStrictEqual(unreachable(dir).sort(), ['examples/README.md', 'examples/one.md']));
});
