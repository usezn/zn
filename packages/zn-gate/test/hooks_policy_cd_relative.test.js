'use strict';

// A relative name after a cd names a file in the folder the cd reached:
// `cd ~/.gemini && echo {} > settings.json` writes the Gemini settings.
// Values are fake; every folder is a temporary one.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const policy = require('../lib/hooks/policy');

const created = [];
after(() => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); });

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-cdrel-'));
  created.push(home);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  return { home, proj, opts: { home, cwd: proj, env: {} } };
}

test('a write to a relative agent file after a cd into its folder is refused', () => {
  const { opts } = tmpHome();
  for (const cmd of [
    // Gemini and Antigravity (folders that are not protected as a whole)
    'cd ~/.gemini && echo x > settings.json',
    'cd ~/.gemini; echo x > settings.json',
    'cd ~/.gemini/config && echo {} > hooks.json',
    'cd ~/.gemini/antigravity-cli && echo {} > settings.json',
    'cd ~/.gemini/antigravity-cli && sed -i s/a/b/ settings.json',
    'cd "$HOME/.gemini" && tee settings.json',
    'cd ~ && cd .gemini && echo x > settings.json',
    'pushd ~/.gemini && cp a settings.json',
    'cd ~/.agents && echo {} > hooks.json',
    // Codex
    'cd ~/.codex; cat > config.toml',
    // Claude Code, Cursor, OpenCode, Copilot
    'cd ~ && cd .claude && tee settings.json',
    'pushd ~/.cursor && cp a hooks.json',
    'cd ~/.config/opencode/plugins && echo x > evil.js',
    'cd ~/.copilot && echo {} > config.json',
    'cd ~/.copilot/hooks && echo {} > hooks.json',
    'cd .gemini && echo x > settings.json',
    'cd ../.gemini && echo x > settings.json',
  ]) {
    assert.match(policy.bashDenial(cmd, opts) || '', /protected|configuration|settings/, cmd);
  }
});

test('a relative agent file after a cd zn cannot follow is refused when the command names the agent folder', () => {
  const { opts } = tmpHome();
  for (const cmd of [
    'D=$HOME/.gemini; cd $D && echo x > settings.json',
    'cd "$(echo ~/.gemini)" && echo x > settings.json',
    'cd "$(echo ~/.claude)" && echo {} > settings.json',
    'cd "$(echo ~/.cursor)" && cp a hooks.json',
    'cd "$(echo ~/.codex)" && echo x > config.toml',
    'cd "$(echo ~/.config/opencode)" && echo x > opencode.json',
    'cd "$(echo ~/.gemini/antigravity-cli)" && echo x > settings.json',
    'cd "$(echo $CODEX_HOME)" && echo x > hooks.json',
  ]) {
    assert.ok(policy.bashDenial(cmd, opts), cmd);
  }
});

test('the same names elsewhere, and reads, are allowed', () => {
  const { opts, proj } = tmpHome();
  fs.mkdirSync(path.join(proj, 'app'));
  for (const cmd of [
    'cd /project && echo x > config.json',
    'cd app && echo x > settings.json',
    'cd app && echo x > hooks.json',
    'cd ~/.gemini && cat settings.json',
    'cd ~/.gemini/config && cat hooks.json',
    'cd ~/.gemini/antigravity-cli && grep model settings.json',
    'cd ~/.gemini && ls',
    'cd $DIR && echo x > config.json',
    'cd "$(mktemp -d)" && echo x > settings.json',
    'cd "$(mktemp -d)" && cat settings.json',
    'echo x > settings.json',
  ]) {
    assert.equal(policy.bashDenial(cmd, opts), null, cmd);
  }
});

test('a secret file read through a cd and a relative name is refused', () => {
  const { opts } = tmpHome();
  for (const cmd of [
    'cd ~/.aws && cat credentials',
    'cd ~ && cd .aws && head -n 1 credentials',
    'cd ~/.kube && cat config',
    'cd ~/.docker && cat config.json',
  ]) {
    assert.match(policy.bashDenial(cmd, opts) || '', /secrets|vault|zn/, cmd);
  }
  for (const cmd of ['cd ~/.aws && ls', 'cd /project && cat credentials', 'cd ~/.kube && ls']) {
    assert.equal(policy.bashDenial(cmd, opts), null, cmd);
  }
});

test('the cd check stays fast on long commands', () => {
  const { opts } = tmpHome();
  const cmd = 'cd ~/.gemini' + ' && cd ..'.repeat(50) + ' && echo ' + 'a'.repeat(5000) + ' > settings.json';
  const t = Date.now();
  policy.bashDenial(cmd, opts);
  assert.ok(Date.now() - t < 3000);
});
