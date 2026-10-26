'use strict';
/* The hooks file of a stand-in zn-gate plugin for Claude Code, in the form the plugin ships. zn-gate check counts a
   plugin only when its hooks/hooks.json has a PreToolUse hook that covers reads, on a script inside the plugin. */

const fs = require('fs');
const path = require('path');

const PRE_CMD = '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code';

// `pre`: fields that replace those of the PreToolUse hook (for example { async: true }).
function pluginHooks(pre = {}) {
  return { hooks: {
    PreToolUse: [{ matcher: '^(Bash|Read|Write)$|^mcp__.*', hooks: [{ type: 'command', shell: 'bash', command: PRE_CMD, timeout: 15, onFailure: 'block', ...pre }] }],
  } };
}

/* Writes hooks/hooks.json (`manifest`, a valid one by default) and the script it names into the plugin folder `root`. */
function writePluginManifest(root, manifest = pluginHooks()) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-node.sh'), '#!/bin/sh\n', { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(manifest));
}

module.exports = { pluginHooks, writePluginManifest };
