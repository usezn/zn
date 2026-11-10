#!/usr/bin/env node
'use strict';

// Builds test/fixtures/benign-commands.expected.json: the Node decision for every line of benign-commands.txt.
// The Python package reads this file in its own corpus test (so it never has to run Node) and
// test/benign_command_corpus.test.js fails when the file is stale.
//
//   destructive  the verdict of lib/destructive.checkCommand ("allow" or "block") and its rule
//   hook         the verdict of the Bash hook policy (lib/hooks/policy.bashDenial) in a small project
//
// The command strings are test data: they are never run. Rewrite the file with
// `node test/fixtures/make_benign_expected.js`.

process.env.ZN_STATS = 'off';
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../../lib/hooks/policy');
const { checkCommand } = require('../../lib/destructive');

const CORPUS = path.join(__dirname, 'benign-commands.txt');
const OUT = path.join(__dirname, 'benign-commands.expected.json');

function readCommands() {
  return fs.readFileSync(CORPUS, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function build() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zn-benign-expected-'));
  try {
    for (const d of ['src', 'data', 'config', 'build', 'notes', 'docs', 'tmp', 'old', 'new', 'downloads', 'vendor', 'out',
      'node_modules', 'dist', 'coverage', 'public', 'logs', 'scripts', 'test', 'cmd', 'assets', 'tests']) {
      fs.mkdirSync(path.join(dir, d), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"my-app","version":"1.0.0"}\n');
    const o = { cwd: dir, home: dir, env: {} };
    return readCommands().map((cmd) => {
      const d = checkCommand(cmd);
      return {
        cmd,
        destructive: d.verdict === 'allow' ? 'allow' : 'block',
        rule: d.verdict === 'allow' ? null : String(d.rule),
        hook: policy.bashDenial(cmd, o) ? 'deny' : 'allow',
      };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const render = () => JSON.stringify(build(), null, 1) + '\n';

if (require.main === module) {
  fs.writeFileSync(OUT, render());
  process.stdout.write(`wrote ${path.relative(process.cwd(), OUT)}\n`);
}

module.exports = { render, OUT };
