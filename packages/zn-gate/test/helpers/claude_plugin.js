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

// zn-node.sh refuses a hook that has not started within 13 s (Claude Code kills it at 15 s). On a busy Windows runner the
// stand-in plugin below (two Node.js starts under Git Bash) has taken longer than that, so the plugin was reported as not
// working and the test failed for a reason it does not check. The tests that use this helper check what zn-gate reports
// and plans for the plugin, not that deadline (plugins/tools/test-claude-plugin-hooks.js does), so on Windows the copy
// gets a longer one, under the 60 s the tests give a hook there (hookTimeoutMs in time_budget.js).
const WIN_START_DEADLINE_S = 50;

function launcherText() {
  const text = fs.readFileSync(ZN_NODE_SH, 'utf8');
  if (process.platform !== 'win32') return text;
  const longer = text.replace(/^DEADLINE=13(\r?)$/m, 'DEADLINE=' + WIN_START_DEADLINE_S + '$1');
  if (longer === text) throw new Error('plugins/zn-gate/scripts/zn-node.sh no longer sets DEADLINE=13: update test/helpers/claude_plugin.js');
  return longer;
}

/* Writes hooks/hooks.json (`manifest`, a valid one by default) and a copy of the plugin's real scripts/zn-node.sh into
   the plugin folder `root` (on Windows with a longer start deadline, see above). */
function writePluginManifest(root, manifest = pluginHooks()) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'zn-node.sh'), launcherText());
  fs.chmodSync(path.join(root, 'scripts', 'zn-node.sh'), 0o755);
  fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), JSON.stringify(manifest));
}

module.exports = { pluginHooks, writePluginManifest };
