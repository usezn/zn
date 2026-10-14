'use strict';

/**
 * zn-gate stats            what zn-gate did on this machine in the last 30 days (local counts only)
 * zn-gate stats --days N   another window (1-90)
 * zn-gate stats --json     the same as JSON
 * zn-gate stats share on|off|status|show
 *                          opt-in sharing of anonymous daily counts (off by default; see lib/stats-share.js)
 */

const stats = require('./stats');
const share = require('./stats-share');

const LAYER_NAMES = { hook: 'agent hooks', shield: 'shield (wrapped MCP servers)', mcp: 'MCP tools', broker: 'secrets broker', cli: 'command line' };

function fmt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

function parse(args) {
  const o = { days: 30, json: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') o.json = true;
    else if (args[i] === '--days' && args[i + 1]) o.days = Number(args[++i]);
    else o.rest.push(args[i]);
  }
  if (!Number.isInteger(o.days) || o.days < 1 || o.days > stats.KEEP_DAYS) o.days = 30;
  return o;
}

function printSummary(s, out) {
  const t = s.total;
  out(`zn-gate on this machine, last ${s.days} day${s.days === 1 ? '' : 's'}` + (s.since ? ` (counting since ${s.since})` : '') + ':\n\n');
  if (!t.checked && !t.blocked && !t.redacted && !t.warned) {
    out('  Nothing recorded yet. Counts start once zn-gate checks something (hooks, MCP tools or wrapped servers).\n');
  } else {
    out(`  ${fmt(t.checked)} checks\n`);
    out(`  ${fmt(t.blocked)} blocked (a secret file read, a pasted secret, a prompt injection or a risky call)\n`);
    out(`  ${fmt(t.redacted)} secret values replaced before the model saw them\n`);
    if (t.warned) out(`  ${fmt(t.warned)} warnings\n`);
    const types = Object.entries(s.detections).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (types.length) out('\n  Secret types found: ' + types.map(([k, n]) => `${k} ${fmt(n)}`).join(', ') + '\n');
    const keys = Object.entries(s.byKey).sort((a, b) => b[1].checked - a[1].checked);
    if (keys.length) {
      out('\n  By agent:\n');
      for (const [key, c] of keys) {
        const [layer, agent] = key.split(':');
        out(`    ${agent} (${LAYER_NAMES[layer] || layer}): ${fmt(c.checked)} checks, ${fmt(c.blocked)} blocked, ${fmt(c.redacted)} replaced\n`);
      }
    }
  }
  const st = share.status();
  out('\n' + (st.share
    ? '  Sharing anonymous daily counts: on. Turn it off with `zn-gate stats share off`.\n'
    : '  These counts stay on this machine. To help improve zn-gate, you can share anonymous daily counts:\n  `zn-gate stats share show` shows exactly what would be sent, `zn-gate stats share on` turns it on.\n'));
  if (!stats.enabled()) out('  Counting is off on this machine (ZN_STATS=off).\n');
}

function explainShare(out) {
  out('What is shared, once a day, only if you turn sharing on: a random id for this installation (a new one each time you turn sharing on), the day, the zn-gate version, the operating system, the Node.js version, the agent and part of zn-gate used most that day, and how many secrets of each type were found (for example AWS_KEY 3). Never secret values, prompts, file names, paths, repository names, hosts or emails.\n');
  out(`Where: ${share.ENDPOINT}. Schema: https://usezn.com/schemas/telemetry.json\n`);
}

async function run(args, out = (s) => process.stdout.write(s)) {
  const o = parse(args);
  if (o.rest[0] === 'share') {
    const sub = o.rest[1] || 'status';
    if (sub === 'on') {
      share.setShare(true);
      out('Sharing anonymous daily counts is on. Counts from today on are sent when you run `zn-gate stats`.\n');
      explainShare(out);
      return 0;
    }
    if (sub === 'off') {
      share.setShare(false);
      out('Sharing is off. Nothing more is sent; your local counts stay on this machine.\n');
      return 0;
    }
    if (sub === 'show') {
      const pending = share.pendingReports();
      explainShare(out);
      if (!share.status().share) out('\nSharing is off, so nothing is sent. With sharing on, a report looks like the ones above in the schema.\n');
      else if (!pending.length) out('\nNothing to send right now (only complete days are sent).\n');
      else out('\nWould be sent now:\n' + pending.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return 0;
    }
    if (sub === 'status') {
      out(share.status().share ? 'Sharing anonymous daily counts: on.\n' : 'Sharing anonymous daily counts: off (the default).\n');
      return 0;
    }
    out('Usage: zn-gate stats share on|off|status|show\n');
    return 2;
  }
  const s = stats.summary({ days: o.days });
  if (o.json) out(JSON.stringify({ ...s, sharing: share.status().share }, null, 2) + '\n');
  else printSummary(s, out);
  if (share.status().share) {
    const res = await share.sendPending({ print: (r) => { if (!o.json) out(`  Sent anonymous counts for ${r.day}.\n`); } });
    if (res.failed && !o.json) out(`  ${res.failed} day(s) could not be sent; they will be tried next time.\n`);
  }
  return 0;
}

module.exports = { run };
