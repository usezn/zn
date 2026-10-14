'use strict';

/**
 * zn-gate pins                      list the MCP servers the shield has pinned
 * zn-gate pins approve <server>     accept the changed or new tools of a server
 * zn-gate pins approve --all        accept them for every server
 *
 * <server> is the start of the key that `zn-gate pins` prints. Approving is a
 * decision for you, in your own terminal: the agent hooks refuse this
 * command from an agent.
 */

const pins = require('./mcp-pins');

function show(cmd) {
  return cmd.join(' ').slice(0, 120);
}

async function run(args) {
  const [sub, which] = args;
  if (!sub || sub === 'list') {
    const servers = pins.list();
    if (!servers.length) {
      process.stdout.write('No MCP server has been pinned yet. Servers are pinned the first time `zn-gate shield` sees their tools.\n');
      return 0;
    }
    process.stdout.write('MCP tool pins (' + pins.pinsFile() + ', mode: ' + pins.mode() + ')\n\n');
    for (const s of servers) {
      process.stdout.write('  ' + s.key + '  ' + show(s.command) + '\n');
      process.stdout.write('      ' + s.tools + ' tool(s) pinned ' + s.pinnedAt + '\n');
      if (s.pending.length) process.stdout.write('      changed or new since then: ' + s.pending.join(', ') + '\n');
    }
    if (servers.some((s) => s.pending.length)) {
      process.stdout.write('\nReview what changed, then accept it with: zn-gate pins approve <server>\n');
    }
    return 0;
  }
  if (sub === 'approve') {
    if (!which) {
      process.stderr.write('usage: zn-gate pins approve <server>|--all\n');
      return 2;
    }
    const r = pins.approve(which);
    if (r.error) {
      process.stderr.write('zn-gate pins: ' + r.error + '. Run zn-gate pins to see the servers.\n');
      return 2;
    }
    if (!r.approved.length) {
      process.stdout.write('Nothing to approve.\n');
      return 0;
    }
    for (const a of r.approved) process.stdout.write('Approved ' + a.tools.join(', ') + ' of ' + show(a.command) + '\n');
    return 0;
  }
  process.stderr.write('usage: zn-gate pins [list] | zn-gate pins approve <server>|--all\n');
  return 2;
}

module.exports = { run };
