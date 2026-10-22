// Tests for check-dependabot-examples.mjs: run with node --test .github/scripts/check-dependabot-examples.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEntries, check } from './check-dependabot-examples.mjs';

const YAML = `version: 2
updates:
  - package-ecosystem: pip
    directories:
      - "/examples/a"  # first
      - /examples/b/
    open-pull-requests-limit: 0
  - package-ecosystem: npm
    directory: "/examples/c"
    schedule:
      interval: weekly
  - package-ecosystem: docker
    directories: ["/examples/d", "/"]
`;

test('parses directory and directories forms', () => {
  assert.deepEqual(parseEntries(YAML), [
    { ecosystem: 'pip', directories: ['/examples/a', '/examples/b/'] },
    { ecosystem: 'npm', directories: ['/examples/c'] },
    { ecosystem: 'docker', directories: ['/examples/d', '/'] },
  ]);
});

test('passes when every manifest is covered', () => {
  const m = [
    { ecosystem: 'pip', dir: '/examples/a', file: 'examples/a/requirements.txt' },
    { ecosystem: 'pip', dir: '/examples/b', file: 'examples/b/requirements.txt' },
    { ecosystem: 'npm', dir: '/examples/c', file: 'examples/c/package.json' },
    { ecosystem: 'docker', dir: '/examples/d', file: 'examples/d/Dockerfile' },
  ];
  assert.deepEqual(check(parseEntries(YAML), m), []);
});

test('fails for a missing directory or the wrong ecosystem', () => {
  const m = [
    { ecosystem: 'pip', dir: '/examples/new', file: 'examples/new/requirements.txt' },
    { ecosystem: 'pip', dir: '/examples/c', file: 'examples/c/requirements.txt' },
  ];
  const problems = check(parseEntries(YAML), m);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /examples\/new\/requirements\.txt/);
});
