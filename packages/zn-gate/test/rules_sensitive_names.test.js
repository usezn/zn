'use strict';

// Library sensitive-path names (path:sensitive_file) for package registry, git and cloud credential files.
// The Python package runs the same cases (tests/test_sensitive_file_names.py), so the two lists stay identical.
// Every name here is a synthetic path; nothing is read from disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluate } = require('../lib/rules');
const { checkToolCall } = require('../lib/client');

const DENY = [
  'cp .npmrc out',
  'cat ~/.npmrc',
  'cat /home/user/.npmrc',
  'cat .npmrc',
  'cp ~/.pypirc out',
  'cat ~/.netrc',
  'cat ~/.docker/config.json',
  'cat ~/.git-credentials',
  'cat ~/.pgpass',
  'cat ~/.config/gh/hosts.yml',
  'cat ~/.kube/config',
  'cat ~/.config/gcloud/access_tokens.db',
  'cat ~/.azure/accessTokens.json',
  'cat ~/.zcode/v2/provider_config.json',
  'cat ~/.ssh/id_ed25519',
  'cat ~/.aws/credentials',
];

const ALLOW = [
  'cat npmrc.md',
  'cat docs/npmrc.md',
  'cat .npmrc.example',
  'cat .npmrc.sample',
  'cat .pypirc.template',
  'cat .netrc.example',
  'cat ~/.kube/config.md',
  'echo registry=https://registry.example.com',
];

test('library evaluate blocks reads and copies of credential file names', () => {
  for (const cmd of DENY) assert.equal(evaluate(cmd).verdict, 'block', cmd);
});

test('library evaluate allows near-miss names and documented templates', () => {
  for (const cmd of ALLOW) assert.equal(evaluate(cmd).verdict, 'allow', cmd);
});

test('a write tool call to a credential file is blocked, a near-miss is allowed', () => {
  assert.equal(checkToolCall('Write', { file_path: '.npmrc', content: 'registry=https://registry.example.com' }).allowed, false);
  assert.equal(checkToolCall('Write', { file_path: '~/.npmrc', content: 'x' }).allowed, false);
  assert.equal(checkToolCall('Write', { file_path: 'npmrc.md', content: 'notes' }).allowed, true);
  assert.equal(checkToolCall('Write', { file_path: '.npmrc.example', content: 'x' }).allowed, true);
});
