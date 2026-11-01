#!/usr/bin/env node
// Pins the repository links of the package READMEs to the release tag before the release build packs them.
// npm and PyPI keep the README of each version forever; a link to blob/main or tree/main would later point to
// files that changed or moved. Run by build-release.yml on the runner's checkout only (the repository keeps main).
//
//   node pin-readme-links.js --tag vX.Y.Z <README.md>...
//
// Rewrites https://github.com/usezn/zn/blob/main/... and .../tree/main/... to .../blob/<tag>/... and fails
// (exit 1) on a bad tag, a missing file, or a main link left over after the rewrite.
'use strict';
const fs = require('node:fs');

const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$/;
const LINK_RE = /(github\.com\/usezn\/zn\/(?:blob|tree))\/main(?=\/)/g;

function pin(text, tag) {
  if (!TAG_RE.test(tag)) throw new Error(`not a release tag: ${tag}`);
  let count = 0;
  const out = text.replace(LINK_RE, (_, head) => { count += 1; return `${head}/${tag}`; });
  if (/github\.com\/usezn\/zn\/(?:blob|tree)\/main\//.test(out)) throw new Error('a main link is left after pinning');
  return { text: out, count };
}

function main(argv) {
  const i = argv.indexOf('--tag');
  const tag = i >= 0 ? argv[i + 1] : '';
  const files = argv.filter((a, j) => a !== '--tag' && j !== i + 1);
  if (!tag || files.length === 0) {
    process.stderr.write('usage: pin-readme-links.js --tag vX.Y.Z <README.md>...\n');
    return 2;
  }
  try {
    for (const f of files) {
      const { text, count } = pin(fs.readFileSync(f, 'utf8'), tag);
      fs.writeFileSync(f, text);
      process.stdout.write(`${f}: ${count} links pinned to ${tag}\n`);
    }
  } catch (err) {
    process.stderr.write(`pin-readme-links: ${err.message}\n`);
    return 1;
  }
  return 0;
}

module.exports = { pin, TAG_RE };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
