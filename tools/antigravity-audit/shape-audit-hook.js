#!/usr/bin/env node
'use strict';

/*
 * Antigravity hook for verification. It records the SHAPE of each payload
 * (event, tool name, keys, value types, lengths) and never the values.
 * It appends one JSON line per call to a local file and, by default, always allows the call.
 *
 * Usage (the hooks.json command passes the event name, and optionally a probe mode):
 *   node shape-audit-hook.js <EventName> [--probe <mode>]
 *
 * Probe modes change only the answer, not the recording. They exist to test the
 * behavior of Antigravity on deny, ask, failures and timeouts. Use them only in a test
 * install, on a matcher that is limited to a tool you will call during the checklist.
 *   allow      (default) answer {"decision":"allow"} on PreToolUse, {} on other events
 *   deny       answer {"decision":"deny","reason":"ZN AUDIT PROBE deny"}
 *   ask        answer {"decision":"ask","reason":"ZN AUDIT PROBE ask"}
 *   force-ask  answer {"decision":"force_ask","reason":"ZN AUDIT PROBE force_ask"}
 *   empty      print nothing, exit 0
 *   exit2      print nothing, exit 2
 *   garbage    print text that is not JSON, exit 0
 *   hang       sleep 120 s (longer than any timeout set in the checklist)
 *
 * Output file: ZN_AUDIT_OUT if set, otherwise zn-antigravity-audit.jsonl in the home folder.
 * Self-test (no hook call, no file written): node shape-audit-hook.js --selftest
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_DEPTH = 6;
const MAX_KEYS = 64;
const MAX_ITEM_SHAPES = 5;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_TOOL = /^[A-Za-z0-9_.:-]{1,80}$/;
const SAFE_LABEL = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;

// Category of a string, never its text. Helps to answer which path style Antigravity sends.
function pathStyle(s) {
  if (s.length === 0) return 'empty';
  if (/^file:/i.test(s)) return 'file_uri';
  if (/^\\\\/.test(s)) return 'windows_unc';
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'windows_drive';
  if (s.startsWith('/')) return 'posix_absolute';
  if (s.startsWith('~')) return 'tilde';
  if (s.includes('\\')) return 'backslash';
  if (s.includes('/')) return 'relative_slash';
  return 'other';
}

function shapeOf(v, depth) {
  if (v === null) return { type: 'null' };
  if (typeof v === 'string') {
    return { type: 'string', length: v.length, pathStyle: v.length <= 4096 ? pathStyle(v) : 'long' };
  }
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  if (Array.isArray(v)) {
    const out = { type: 'array', length: v.length };
    if (depth < MAX_DEPTH) {
      const seen = new Map();
      for (const item of v.slice(0, 50)) {
        const s = shapeOf(item, depth + 1);
        const key = JSON.stringify(s);
        if (!seen.has(key)) seen.set(key, s);
        if (seen.size >= MAX_ITEM_SHAPES) break;
      }
      out.items = [...seen.values()];
    }
    return out;
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    const out = { type: 'object', keyCount: keys.length, keys: {} };
    let unsafe = 0;
    for (const k of keys.slice(0, MAX_KEYS)) {
      if (!SAFE_KEY.test(k)) { unsafe += 1; continue; }
      out.keys[k] = depth < MAX_DEPTH ? shapeOf(v[k], depth + 1) : { type: typeof v[k] };
    }
    if (keys.length > MAX_KEYS) unsafe += keys.length - MAX_KEYS;
    if (unsafe) out.unsafeKeyCount = unsafe; // names of odd keys are not recorded
    return out;
  }
  return { type: typeof v };
}

function buildRecord(event, rawText, label) {
  const rec = {
    ts: new Date().toISOString(),
    event: SAFE_LABEL.test(event || '') ? event : '<unsafe>',
    platform: process.platform,
    node: process.version,
    stdinBytes: Buffer.byteLength(rawText || '', 'utf8'),
  };
  if (label) rec.probe = label;
  let payload;
  try {
    payload = JSON.parse(rawText);
    rec.parse = 'ok';
  } catch (_) {
    rec.parse = 'error';
    return rec;
  }
  if (payload && typeof payload === 'object') {
    rec.topKeys = shapeOf(payload, 0).keys;
    if (typeof payload.hookEventName === 'string') {
      rec.hookEventNameInStdin = SAFE_TOOL.test(payload.hookEventName) ? payload.hookEventName : '<unsafe>';
    }
    const call = payload.toolCall;
    if (call && typeof call === 'object') {
      rec.toolName = typeof call.name === 'string' && SAFE_TOOL.test(call.name) ? call.name : '<unsafe-or-missing>';
      rec.toolCallShape = shapeOf(call, 0);
    }
    if (typeof payload.error === 'string') rec.errorLength = payload.error.length;
    if (Array.isArray(payload.workspacePaths)) rec.workspacePathCount = payload.workspacePaths.length;
  }
  return rec;
}

function answer(event, mode) {
  const isPre = event === 'PreToolUse';
  const reason = (kind) => ({ decision: kind, reason: `ZN AUDIT PROBE ${kind}` });
  switch (mode) {
    case 'deny': return { out: JSON.stringify(reason('deny')), code: 0 };
    case 'ask': return { out: JSON.stringify(reason('ask')), code: 0 };
    case 'force-ask': return { out: JSON.stringify({ decision: 'force_ask', reason: 'ZN AUDIT PROBE force_ask' }), code: 0 };
    case 'empty': return { out: '', code: 0 };
    case 'exit2': return { out: '', code: 2 };
    case 'garbage': return { out: 'this is not json', code: 0 };
    default: return { out: isPre ? '{"decision":"allow"}' : '{}', code: 0 };
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--selftest') return selftest();
  const event = args[0] || 'unlabelled';
  const pIdx = args.indexOf('--probe');
  const mode = pIdx >= 0 && args[pIdx + 1] ? args[pIdx + 1] : 'allow';

  const raw = readStdin();
  try {
    const rec = buildRecord(event, raw, pIdx >= 0 ? mode : null);
    const file = process.env.ZN_AUDIT_OUT || path.join(os.homedir(), 'zn-antigravity-audit.jsonl');
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { encoding: 'utf8' });
  } catch (e) {
    process.stderr.write('zn audit: could not write the record (' + (e && e.code ? e.code : 'error') + ')\n');
  }
  if (mode === 'hang') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
  }
  const { out, code } = answer(event, mode);
  if (out) process.stdout.write(out);
  process.exitCode = code;
}

function selftest() {
  const secret = 'AKIAEXAMPLEONLY0000';
  const payload = JSON.stringify({
    conversationId: 'c-1234',
    workspacePaths: ['C:\\Users\\example\\repo'],
    toolCall: { name: 'run_command', args: { CommandLine: 'echo ' + secret, Cwd: '/home/example/x', 'Odd Key!': 1 } },
    stepIdx: 3,
  });
  const rec = buildRecord('PreToolUse', payload, null);
  const text = JSON.stringify(rec);
  const leaked = [secret, 'c-1234', 'C:\\\\Users', '/home/example', 'echo '].filter((s) => text.includes(s));
  const ok = leaked.length === 0 && rec.toolName === 'run_command' && rec.toolCallShape.keys.args.keys.CommandLine.type === 'string' &&
    rec.toolCallShape.keys.args.keys.CommandLine.length === ('echo ' + secret).length && rec.toolCallShape.keys.args.unsafeKeyCount === 1;
  if (!ok) {
    process.stderr.write('SELFTEST FAIL: leaked=' + leaked.length + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('SELFTEST OK\n');
}

if (require.main === module) {
  main();
} else {
  module.exports = { shapeOf, buildRecord, pathStyle };
}
