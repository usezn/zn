'use strict';
/**
 * Confirmation of zn Team changes of the "confirm" class (they only tighten
 * or are reversible), on a channel the model cannot answer:
 *
 *   a. MCP elicitation (form mode), when the client declared it: the client
 *      renders the question to the person and the model never sees it.
 *   b. A native OS dialog (the `gui` channel of the vault): "No" is the
 *      default button and no answer in 120 s counts as no.
 *   c. No channel: the change stays pending and the person approves it in
 *      the zn dashboard (approval link).
 *
 * There is deliberately no terminal command to confirm a change: anything
 * printed for the person to type would be in the model's context, and the
 * agent's own shell could run it.
 *
 * ZN_TEAM_CONFIRM = auto (default) | elicitation | dialog | dashboard forces
 * a channel; a forced channel that is not available falls back to the
 * dashboard. Nothing skips the confirmation.
 *
 * The person must see the whole change: when the summary has more than
 * MAX_SUMMARY_LINES lines, or a line longer than MAX_LINE_CHARS (after
 * invisible characters are shown as XXXX), no in-client channel is offered
 * and the change goes to the dashboard.
 */

const vaultConfirm = require('../../vault/confirm');

const { field, render } = vaultConfirm;
const MODES = ['auto', 'elicitation', 'dialog', 'dashboard'];
const ELICITATION_TIMEOUT_MS = 120000;
const TITLE = 'zn Team change';
const MAX_SUMMARY_LINES = 20;
const MAX_LINE_CHARS = 300;

function summaryOf(change) {
  const c = change || {};
  return Array.isArray(c.summary) && c.summary.length ? c.summary : [String(c.kind || 'change')];
}

/** True when every summary line can be shown in full on the confirmation surface. */
function summaryFits(change) {
  const summary = summaryOf(change);
  if (summary.length > MAX_SUMMARY_LINES) return false;
  return summary.every((s) => typeof s === 'string' && field(s, Infinity).length <= MAX_LINE_CHARS);
}

function confirmMode(env) {
  const raw = String(((env || process.env).ZN_TEAM_CONFIRM || 'auto')).trim().toLowerCase();
  return MODES.includes(raw) ? { mode: raw, valid: true } : { mode: 'dashboard', valid: false };
}

function minutesLeft(deadline, now) {
  const t = Date.parse(deadline || '');
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 60000));
}

/**
 * The confirmation request shown on every channel: built by zn-gate from
 * the server's change (summary lines come from the server, computed from the
 * parameters only). Values that came from people or the agent (org and token
 * names, client, note) go through field(), which shows invisible and bidi
 * characters as \uXXXX and keeps each on one line. The agent's note is last
 * and marked as unverified.
 *
 * {change, whoami, deadline, now} -> {title, warnings, fields, footer}
 */
function buildRequest({ change, whoami, deadline, now }) {
  const c = change || {};
  const w = whoami || {};
  const org = w.org || {};
  const rb = c.requested_by || {};
  const tok = (w.principal || w.token || {});
  const tokenName = rb.token_name || tok.name || '';
  const prefix = rb.token_prefix || tok.prefix || '';
  const client = rb.client && rb.client.name ? rb.client : null;
  const lines = [];
  lines.push('zn Team · ' + field(org.name || 'organization', 80) + ' (' + field(org.id || '?', 40) + ')');
  let by = 'Requested by token "' + field(tokenName, 64) + '" (' + field(prefix, 40) + ')';
  if (client) by += ' via ' + field(client.name, 64) + (client.version ? ' ' + field(client.version, 32) : '');
  lines.push(by);
  lines.push('');
  const summary = summaryOf(c);
  for (const s of summary.slice(0, MAX_SUMMARY_LINES)) lines.push(field(s, MAX_LINE_CHARS));
  lines.push('');
  const left = minutesLeft(deadline || c.deadline, now === undefined ? Date.now() : now);
  lines.push('Change ' + field(c.id, 40) + ' · digest ' + field(c.digest8, 16) + (left === null ? '' : ' · expires in ' + left + ' min'));
  const fields = [];
  if (c.note) fields.push(['Note from the agent (unverified)', c.note]);
  return { title: TITLE, warnings: lines, fields, footer: 'Only approve if you asked your agent for this change.' };
}

const REQUESTED_SCHEMA = {
  type: 'object',
  properties: { confirm: { type: 'boolean', title: 'Apply this change', default: false } },
  required: ['confirm'],
};

/**
 * Which channels this process can use, in order. The dashboard is always
 * last. {elicitation: bool, dialog: bool, env} -> ['elicitation', 'dialog', 'dashboard']
 */
function availableChannels({ elicitation, dialog, env }) {
  const { mode } = confirmMode(env);
  const out = [];
  if ((mode === 'auto' || mode === 'elicitation') && elicitation) out.push('elicitation');
  if ((mode === 'auto' || mode === 'dialog') && dialog) out.push('dialog');
  out.push('dashboard');
  return out;
}

/**
 * Ask the person. Returns {decision:'approved'|'declined'|'unavailable', via, detail}.
 *
 * deps:
 *   elicit(params) -> Promise<{action, content}>   (rejects when the client
 *                     failed or did not answer; a timeout counts as cancel)
 *   elicitationSupported: bool
 *   gui: {available(): bool, confirm(req): Promise<bool>}
 *   protocolVersion: negotiated MCP version (mode:"form" is sent from 2025-11-25)
 *   env, now
 */
async function askPerson({ change, whoami, deadline }, deps) {
  const d = deps || {};
  // Never ask about a change the person cannot read in full: the dashboard shows all of it.
  if (!summaryFits(change)) return { decision: 'unavailable', via: null, detail: 'summary_too_long' };
  const gui = d.gui || null;
  const dialogOk = Boolean(gui && safe(() => gui.available()));
  const channels = availableChannels({ elicitation: Boolean(d.elicitationSupported && d.elicit), dialog: dialogOk, env: d.env });
  const req = buildRequest({ change, whoami, deadline, now: d.now ? d.now() : Date.now() });
  for (const ch of channels) {
    if (ch === 'elicitation') {
      const params = { message: render(req), requestedSchema: REQUESTED_SCHEMA };
      if (d.protocolVersion && d.protocolVersion >= '2025-11-25') params.mode = 'form';
      let res;
      try {
        res = await d.elicit(params, ELICITATION_TIMEOUT_MS);
      } catch (err) {
        if (err && err.code === 'ZN_TIMEOUT') return { decision: 'declined', via: 'elicitation', detail: 'no answer' };
        continue; // the client failed to show it: try the next channel
      }
      const action = res && res.action;
      if (action === 'accept' && res.content && res.content.confirm === true) return { decision: 'approved', via: 'elicitation' };
      return { decision: 'declined', via: 'elicitation', detail: action === 'accept' ? 'not confirmed' : String(action || 'cancel') };
    }
    if (ch === 'dialog') {
      try {
        const yes = await gui.confirm(req);
        return yes === true ? { decision: 'approved', via: 'dialog' } : { decision: 'declined', via: 'dialog' };
      } catch (_) {
        continue; // no desktop session after all
      }
    }
  }
  return { decision: 'unavailable', via: null };
}

function safe(fn) {
  try { return fn(); } catch (_) { return false; }
}

/** The native dialog of this machine, with an environment that does not carry the token. */
function defaultGui(env) {
  const clean = Object.assign({}, env || process.env);
  delete clean.ZN_ORG_TOKEN;
  return {
    available: () => vaultConfirm.guiAvailable({ env: clean }),
    confirm: (req) => vaultConfirm.guiChannel({ env: clean }).confirm(req),
  };
}

module.exports = {
  MAX_SUMMARY_LINES,
  MAX_LINE_CHARS,
  summaryFits,
  MODES,
  REQUESTED_SCHEMA,
  ELICITATION_TIMEOUT_MS,
  confirmMode,
  buildRequest,
  availableChannels,
  askPerson,
  defaultGui,
  render,
};
