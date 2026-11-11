// Tests of changed-workflows-summary.mjs. Run: node --test .github/scripts/changed-workflows-summary.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { summaryMarkdown, workflowFiles } from './changed-workflows-summary.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'changed-workflows-summary.mjs');
const HEADING = '### Workflows changed by this pull request';

test('only .yml and .yaml files directly under .github/workflows count', () => {
  const paths = [
    '.github/workflows/ci.yml',
    '.github/workflows/x.yaml',
    '.github/workflows/readme.md',
    '.github/workflows/sub/b.yml',
    '.github/scripts/a.mjs',
    'docs/a.yml',
    'x/.github/workflows/c.yml',
  ];
  assert.deepEqual(workflowFiles(paths), ['.github/workflows/ci.yml', '.github/workflows/x.yaml']);
});

test('the summary is a heading with one line per file, or says that none changed', () => {
  assert.equal(summaryMarkdown([]), `${HEADING}\n\nNo workflow file changed.\n`);
  assert.equal(summaryMarkdown(['.github/workflows/ci.yml']), `${HEADING}\n\n- \`.github/workflows/ci.yml\`\n`);
});

test('the script lists the workflow files that differ from the base and writes them to the job summary', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'wfsummary-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, '.github/workflows/ci.yml'), 'name: CI\n');
  fs.writeFileSync(path.join(dir, 'docs/a.md'), '# A\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(dir, '.github/workflows/ci.yml'), 'name: CI 2\n');
  fs.writeFileSync(path.join(dir, '.github/workflows/deploy.yaml'), 'name: Deploy\n');
  fs.writeFileSync(path.join(dir, 'docs/a.md'), '# B\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');

  const summary = path.join(dir, 'summary.md');
  const out = execFileSync(process.execPath, [script, base], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
  });
  const expected = `${HEADING}\n\n- \`.github/workflows/ci.yml\`\n- \`.github/workflows/deploy.yaml\`\n`;
  assert.equal(fs.readFileSync(summary, 'utf8'), expected);
  assert.equal(out, expected);
});

test('the script fails when the base cannot be read', () => {
  assert.throws(() => execFileSync(process.execPath, [script, 'no-such-ref-0000'], {
    cwd: here,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
});
