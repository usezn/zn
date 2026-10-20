'use strict';

// Tests only: what Codex writes to config.toml when the user approves zn's hooks in /hooks
// ([hooks.state."<hooks file>:<event>:<group>:<hook>"] trusted_hash = "sha256:..."). Made-up folders only.

const fs = require('fs');
const path = require('path');
const { hookHash } = require('../../lib/codex-trust');
const { isOurs } = require('../../lib/agents/config-file');

/** The [hooks.state] tables for every zn hook in `hooksFile` that `text` (a config.toml) does not already have. */
function trustToml(hooksFile, text = '') {
  const tree = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  let add = '';
  for (const [event, groups] of Object.entries(tree.hooks || {})) {
    groups.forEach((group, gi) => group.hooks.forEach((hook, hi) => {
      if (!isOurs(hook.command, 'codex')) return;
      const key = hooksFile + ':' + event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase() + ':' + gi + ':' + hi;
      if (text.includes('[hooks.state.' + JSON.stringify(key) + ']')) return;
      add += '\n[hooks.state.' + JSON.stringify(key) + ']\ntrusted_hash = "' + hookHash(event, group, hook) + '"\n';
    }));
  }
  return add;
}

/** Approves every zn hook in `hooksFile` by appending its trusted_hash to the config.toml next to it (once per hook). */
function trustCodexHooks(hooksFile) {
  const config = path.join(path.dirname(hooksFile), 'config.toml');
  let text = '';
  try { text = fs.readFileSync(config, 'utf8'); } catch (_) { text = ''; }
  const add = trustToml(hooksFile, text);
  if (add) fs.writeFileSync(config, text + (text && !text.endsWith('\n') ? '\n' : '') + add);
}

module.exports = { trustCodexHooks, trustToml };
