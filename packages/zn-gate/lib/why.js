'use strict';
/**
 * `zn why [<id>]`: explains, in plain words, the last block in the local evidence log, or the
 * record with the given id. It only reads the log: it takes no lock, writes nothing, counts
 * nothing and does not use the network. What it prints about a record is what the log already
 * holds (the redacted preview of at most 120 characters), run through the secret redaction once
 * more, so a record written by another tool or edited by hand never shows a secret value here.
 *
 * Exit codes: 0 explained, 1 nothing to explain (no log, no block, id not found, log unreadable),
 * 2 wrong use.
 */

const fs = require('fs');
const { explainRule } = require('./rule-explanations');

const USAGE = 'usage: zn why [<id>]    (the id is the "id" of a record of `zn evidence --export`; with no id, the last block is explained)';

const PHASE_WORDS = {
  'hook-pre_tool': 'a tool call, checked by the zn hook before it ran',
  'hook-post_tool': 'the output of a tool, checked by the zn hook',
  'hook-user_prompt': 'a prompt you typed, checked by the zn hook before it went to the model',
  'tool-call': 'a call to an MCP tool, checked by zn-shield',
  'tool-result': 'the output of an MCP tool, checked by zn-shield',
  'tool-definition': 'the description of an MCP tool, checked by zn-shield',
  'parameter-definition': 'a parameter of an MCP tool, checked by zn-shield',
  'tool-pin': 'the tools of an MCP server, checked by zn-shield against what you approved',
};

// Text from the log, made safe to print: no control characters or escape sequences, secrets
// redacted again, cut to `max` characters.
function show(value, max) {
  let s = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  s = s.slice(0, 4096).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
  try {
    s = String(require('./rules').redactSecrets(s).sanitized || '');
  } catch {
    s = '[not shown]';
  }
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// The log is read from its end in blocks, so a large log is never loaded whole (a Node string
// tops out near 512 MB). A record is a line of about 120 characters of preview plus a short
// reason, so a line longer than MAX_LINE_BYTES is counted as damaged without being kept.
const BLOCK_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;

function readAt(fd, buf, start) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.readSync(fd, buf, off, buf.length - off, start + off);
    if (n === 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

/**
 * Visits the records of the log from its last line back to its first, reading the file backwards
 * in blocks, and stops as soon as visit(record) returns true. Lines are split on the byte 0x0A,
 * which never occurs inside a UTF-8 sequence, so a character cut by a block edge is decoded whole.
 * Returns null when there is no file, else { count, damaged, stopped }: count is the number of
 * JSON objects visited and damaged the lines that could not be read. Both are exact only when the
 * whole log was read (stopped is false).
 */
function scanTail(file, visit, opts = {}) {
  const blockBytes = opts.blockBytes || BLOCK_BYTES;
  const maxLine = opts.maxLineBytes || MAX_LINE_BYTES;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    const err = new Error(e.code || e.message);
    err.unreadable = true;
    throw err;
  }
  const stats = { count: 0, damaged: 0, stopped: false };
  // Returns true when the visitor wants no more records.
  const handle = (line) => {
    if (line.length > maxLine) { stats.damaged++; return false; }
    const t = line.toString('utf8').trim();
    if (t === '') return false;
    let rec;
    try { rec = JSON.parse(t); } catch { stats.damaged++; return false; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { stats.damaged++; return false; }
    stats.count++;
    if (visit(rec)) { stats.stopped = true; return true; }
    return false;
  };
  try {
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0); // the start of the line still open, read so far (no newline in it)
    let openTooLong = false; // the open line is over maxLine, so its bytes were dropped
    while (pos > 0) {
      const start = Math.max(0, pos - blockBytes);
      const block = readAt(fd, Buffer.alloc(pos - start), start);
      pos = start;
      const buf = carry.length > 0 ? Buffer.concat([block, carry]) : block;
      let end = buf.length;
      let newline;
      while (end > 0 && (newline = buf.lastIndexOf(NEWLINE, end - 1)) !== -1) {
        if (openTooLong) {
          stats.damaged++;
          openTooLong = false;
        } else if (handle(buf.subarray(newline + 1, end))) {
          return stats;
        }
        end = newline;
      }
      const left = buf.subarray(0, end);
      if (openTooLong || left.length > maxLine) {
        openTooLong = true;
        carry = Buffer.alloc(0);
      } else {
        carry = left;
      }
    }
    // The start of the file: what is left is the first line.
    if (openTooLong) stats.damaged++;
    else if (carry.length > 0) handle(carry);
    return stats;
  } finally {
    fs.closeSync(fd);
  }
}

const isBlock = (rec) => typeof rec.verdict === 'string' && rec.verdict.toLowerCase() === 'block';

function describeWhat(rec) {
  const phase = typeof rec.phase === 'string' ? rec.phase : '';
  const what = PHASE_WORDS[phase] || (phase.startsWith('server-message') ? 'a message from an MCP server, checked by zn-shield' : null);
  const tool = rec.tool_name && rec.tool_name !== 'unknown' ? ' "' + show(rec.tool_name, 60) + '"' : '';
  const agent = rec.agent_environment && rec.agent_environment !== 'unknown' ? ' (agent: ' + show(rec.agent_environment, 40) + ')' : '';
  return (what ? what : (phase ? 'an event of kind "' + show(phase, 40) + '"' : 'an event')) + (tool ? ', tool' + tool : '') + agent;
}

function render(rec, znCommand, damaged) {
  const out = [];
  const blocked = isBlock(rec);
  const verdict = typeof rec.verdict === 'string' ? rec.verdict.toLowerCase() : 'unknown';
  out.push((blocked ? 'zn blocked this' : 'zn did not block this (verdict: ' + show(verdict, 20) + ')') +
    (rec.timestamp ? ' at ' + show(rec.timestamp, 30) + ' (UTC)' : '') + '.');
  out.push('  Record:  ' + show(rec.id, 60));
  out.push('  What:    ' + describeWhat(rec));
  if (typeof rec.payload_preview === 'string' && rec.payload_preview !== '') {
    out.push('  Preview: ' + show(rec.payload_preview, 120) + '   (as stored in the log, with secrets already removed)');
  }

  const ruleId = typeof rec.rule === 'string' && rec.rule !== '' ? rec.rule : null;
  if (!ruleId) {
    out.push('  Rule:    not recorded. This record has no rule id, so zn cannot say which rule fired.');
    if (rec.reason) out.push('  Reason stored: ' + show(rec.reason, 240));
    out.push('');
    out.push('The log does not hold enough to explain this record. Run `' + znCommand('evidence --export') + '` to see everything it stores.');
  } else {
    const info = explainRule(ruleId, rec);
    if (!info) {
      out.push('  Rule:    ' + show(ruleId, 80) + ' (zn has no plain-words explanation for this id)');
      if (rec.reason) out.push('  Reason stored: ' + show(rec.reason, 240));
      out.push('');
      out.push('This id may come from a newer or an older zn-gate, or from a custom setup. Update zn-gate and try again; no command is guessed here.');
    } else {
      out.push('  Rule:    ' + show(ruleId, 80) + ' - ' + info.name);
      out.push('');
      out.push('Why it matters: ' + info.matters);
      out.push('');
      const a = info.allow;
      if (a.command) {
        out.push('To go on, run this in your own terminal (not through your agent):');
        out.push('  ' + znCommand(a.command));
        out.push(a.note);
      } else {
        out.push(a.note);
        if (a.who) out.push('Who decides: ' + a.who);
      }
      if (info.incomplete) {
        out.push('');
        out.push('Missing from the log: which check of the hook fired.');
      }
    }
  }
  if (damaged > 0) {
    out.push('');
    out.push('Note: ' + damaged + ' line(s) of the log could not be read and were skipped. `' + znCommand('evidence --verify') + '` tells you more.');
  }
  return out.join('\n') + '\n';
}

/**
 * Runs the command. `io` is for tests: { file, stdout, stderr, znCommand }.
 * Returns the exit code.
 */
function runWhy(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  const znCommand = io.znCommand || require('./zn-command').znCommand;
  const err = (s) => stderr('zn why: ' + s + '\n');

  const args = argv.slice();
  let id = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { positional.push(...args.slice(i + 1)); break; }
    if (args[i].startsWith('-')) {
      err('unknown option "' + show(args[i], 30) + '". ' + USAGE);
      return 2;
    }
    positional.push(args[i]);
  }
  if (positional.length > 1) {
    err('too many arguments. ' + USAGE);
    return 2;
  }
  if (positional.length === 1) id = positional[0];

  const file = io.file || require('./evidence').EVIDENCE_FILE;
  // The log is read from its end and the scan stops at the first match, which is the last one.
  let rec = null;
  const visit = id !== null
    ? (r) => { if (r.id === id) { rec = r; return true; } return false; }
    : (r) => { if (isBlock(r)) { rec = r; return true; } return false; };
  let scan;
  try {
    scan = scanTail(file, visit, io);
  } catch (e) {
    err('the evidence log cannot be read (' + show(e.message, 40) + '). Nothing was changed.');
    return 1;
  }
  if (scan === null) {
    err('there is no evidence log yet, so no block has been recorded on this computer.');
    return 1;
  }
  const { count, damaged } = scan;
  const damageNote = damaged > 0 ? ' ' + damaged + ' line(s) of the log could not be read, and it may be among them (`' + znCommand('evidence --verify') + '` tells you more).' : '';

  if (!rec) {
    if (id !== null) {
      err('no record with the id "' + show(id, 40) + '" in the evidence log.' + damageNote);
      return 1;
    }
    err((count === 0 && damaged === 0 ? 'the evidence log is empty' : 'no block is recorded in the evidence log') + ', so there is nothing to explain.' + damageNote);
    return 1;
  }
  stdout(render(rec, znCommand, damaged));
  return 0;
}

module.exports = { runWhy, scanTail, USAGE };
