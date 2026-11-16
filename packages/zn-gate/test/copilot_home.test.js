'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { copilotHome } = require('../lib/agents/copilot');

const FAKE_HOME = path.join(path.sep, 'home', 'example-user');

test('COPILOT_HOME wins over the home option', () => {
  const dir = path.join(path.sep, 'srv', 'copilot-data');
  assert.equal(copilotHome({ env: { COPILOT_HOME: dir }, home: FAKE_HOME }), dir);
});

test('COPILOT_HOME is used when the home option is missing', () => {
  const dir = path.join(path.sep, 'srv', 'copilot-data');
  assert.equal(copilotHome({ env: { COPILOT_HOME: dir } }), dir);
});

test('an empty COPILOT_HOME falls back to <home>/.copilot', () => {
  assert.equal(copilotHome({ env: { COPILOT_HOME: '' }, home: FAKE_HOME }), path.join(FAKE_HOME, '.copilot'));
});

test('an unset COPILOT_HOME falls back to <home>/.copilot', () => {
  assert.equal(copilotHome({ env: {}, home: FAKE_HOME }), path.join(FAKE_HOME, '.copilot'));
});

test('a relative COPILOT_HOME is returned as given', () => {
  assert.equal(copilotHome({ env: { COPILOT_HOME: 'rel/copilot' }, home: FAKE_HOME }), 'rel/copilot');
});

test('a COPILOT_HOME with spaces is returned unchanged', () => {
  const dir = path.join(path.sep, 'srv', 'my copilot data');
  assert.equal(copilotHome({ env: { COPILOT_HOME: dir }, home: FAKE_HOME }), dir);
});

test('a home option with spaces is kept in the default path', () => {
  const home = path.join(path.sep, 'home', 'example user');
  assert.equal(copilotHome({ env: {}, home }), path.join(home, '.copilot'));
});

test('without a home option the default is under the OS home folder', () => {
  const os = require('os');
  assert.equal(copilotHome({ env: {} }), path.join(os.homedir(), '.copilot'));
});
