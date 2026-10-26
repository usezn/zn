'use strict';
/* The hooks file of a stand-in zn-gate plugin for Claude Code, in the form the plugin ships. zn-gate check counts a
   plugin only when its hooks/hooks.json has the exact PreToolUse hook the plugin ships, covering reads, and runs that
   command (/bin/sh on scripts/zn-node.sh, which starts scripts/zn-launch.js with a Node.js from an absolute PATH entry). */

const fs = require('fs');
const path = require('path');

const PRE_CMD = '/bin/sh "${CLAUDE_PLUGIN_ROOT}/scripts/zn-node.sh" PreToolUse hook claude-code';

// `pre`: fields that replace those of the PreToolUse hook (for example { async: true }).
function pluginHooks(pre = {}) {
  return { hooks: {
    PreToolUse: [{ matcher: '^(Bash|Read|Write)$|^mcp__.*', hooks: [{ type: 'command', shell: 'bash', command: PRE_CMD, timeout: 15, onFailure: 'block', ...pre }] }],
  } };
}

// The plugin's real launcher script in this repository.
const ZN_NODE_SH = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'zn-gate', 'scripts', 'zn-node.sh');

/* Writes hooks/hooks.json (`manifest`, a valid one by default) and a copy of the plugin's real scripts/zn-node.sh into
   the plugin folder `root`. */
function writePluginManifest(root, manifest = pluginHooks()) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(ZN_NODE_SH, path.join(root, 'scripts', 'zn-node.sh'));
  fs.chmodSync(path.join(root, 'scripts', 'zn-node.sh'), 0o755);
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(manifest));
}

module.exports = { pluginHooks, writePluginManifest };
