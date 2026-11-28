'use strict';

process.env.ZN_STATS = 'off';

// A compose file written by a tool call: its volumes: entries are read like docker run -v. Only example paths; nothing is run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkToolCall } = require('../lib/guard');

const compose = (...entries) => `services:\n  app:\n    image: img\n    volumes:\n${entries.map((e) => `      - ${e}\n`).join('')}`;
const verdict = (file, content) => checkToolCall('Write', { file_path: file, content }).verdict;

test('a compose file that mounts a protected host path is refused', () => {
  for (const c of [
    compose('~/.ssh:/root/.ssh'),
    compose('"~/.aws:/root/.aws:ro"'),
    compose('${HOME}/.ssh:/k'),
    compose('/home/user/.aws/credentials:/c:ro'),
    compose('./.env:/app/.env'),
    'services:\n  app:\n    volumes:\n      - type: bind\n        source: ~/.ssh\n        target: /k\n',
  ]) {
    assert.equal(verdict('/proj/docker-compose.yml', c), 'block', c);
    assert.equal(verdict('/proj/stack.yaml', c), 'block', c);
  }
});

test('a compose file with named volumes and harmless binds is allowed', () => {
  for (const c of [
    compose('./data:/data'),
    compose('named:/data', './src:/src:ro'),
    compose('~/.ssh/known_hosts:/k:ro'),
    'services:\n  app:\n    image: img\n    env_file: ./app.env\n',
  ]) assert.equal(verdict('/proj/docker-compose.yml', c), 'allow', c);
});

test('the command forms stay refused or allowed as before', () => {
  const cmd = (c) => checkToolCall('Bash', { command: c }).verdict;
  for (const c of ['docker run --volume ~/.ssh:/k img', 'podman run --mount src=~/.aws,dst=/k img', 'nerdctl run -v"$HOME/.ssh":/k img']) assert.equal(cmd(c), 'block', c);
  for (const c of ['docker run -v $PWD/data:/data img', 'docker run -v named:/d img', 'docker run --env-file=.env img']) assert.equal(cmd(c), 'allow', c);
});
