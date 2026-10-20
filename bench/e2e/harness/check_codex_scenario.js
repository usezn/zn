#!/usr/bin/env node
'use strict';
/**
 * Checks one Codex hook scenario run (see run_codex_scenarios.sh) from what
 * the provider received and what the hooks logged. Prints one PASS/FAIL line
 * per check and, for scenarios that record an observation, INFO lines. Fake
 * values are replaced by their names. Exit 1 if any check fails.
 *
 *   node check_codex_scenario.js <scenario> <run dir>
 *
 * Writes <run>/out/hooks.txt: every hook call (event, tool, what zn answered).
 */

const fs = require('fs');
const path = require('path');

const SCEN = process.argv[2];
const RUN = path.resolve(process.argv[3]);
const OUT = path.join(RUN, 'out');
const read = (f, def = '') => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return def; } };
const lines = (f) => read(f).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

const values = JSON.parse(read(path.join(RUN, 'values.json'), '[]')).concat(JSON.parse(read(path.join(RUN, 'mcp-values.json'), '[]')));
const redact = (s) => {
  let out = String(s);
  for (const v of values) out = out.split(v.value).join('<<VALUE:' + v.name + '>>');
  return out.split(RUN).join('<run>');
};
const hasValue = (s) => values.some((v) => String(s).includes(v.value));

const spy = lines(path.join(OUT, 'hook_spy.jsonl'));
const reqs = lines(path.join(OUT, 'requests.jsonl'));
const mainReqs = reqs.filter((r) => r.body && Array.isArray(r.body.tools) && r.body.tools.length);
const exits = read(path.join(OUT, 'exit_codes.txt'));
const codexExit = Number((/task exit=(\d+)/.exec(exits) || [])[1]);

const answer = (s) => { try { return s.stdout.trim() ? JSON.parse(s.stdout) : null; } catch (_) { return { unparsed: s.stdout }; } };
const ofEvent = (name) => spy.filter((s) => s.input && s.input.hook_event_name === name);
const toolOutputs = () => {
  const last = mainReqs[mainReqs.length - 1];
  const input = last && Array.isArray(last.body.input) ? last.body.input : [];
  return input.filter((i) => /_output$/.test(i.type || '')).map((i) => (typeof i.output === 'string' ? i.output : JSON.stringify(i.output)));
};
const allInputText = () => JSON.stringify(mainReqs.map((r) => r.body.input));

const report = [];
let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  report.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' (' + detail + ')' : ''));
};
const info = (text) => report.push('INFO ' + text);

// What each hook call was and what zn answered (values replaced by names).
const hooksTxt = spy.map((s) => {
  const i = s.input || {};
  const a = answer(s);
  const subject = i.tool_input ? (i.tool_input.command !== undefined ? i.tool_input.command : JSON.stringify(i.tool_input)) : i.last_assistant_message !== undefined ? 'last message: ' + i.last_assistant_message : '';
  return [i.hook_event_name + ' ' + (i.tool_name || '') + (i.stop_hook_active ? ' (stop_hook_active)' : ''), '  input: ' + redact(String(subject)).slice(0, 300), '  zn answered: ' + (a ? redact(JSON.stringify(a)).slice(0, 500) : '(nothing)') + ', exit ' + s.exit].join('\n');
}).join('\n\n');
fs.writeFileSync(path.join(OUT, 'hooks.txt'), hooksTxt + '\n');

check('Codex exited with code 0', codexExit === 0, 'exit ' + exits.trim());
check('no hook run failed', spy.every((s) => s.exit === 0), spy.map((s) => s.exit).join(','));

if (SCEN === 'permission') {
  const pr = ofEvent('PermissionRequest');
  check('PermissionRequest fired for both commands', pr.length === 2, pr.length + ' call(s)');
  const first = pr.find((s) => String(s.input.tool_input && s.input.tool_input.command).includes('__ZN_DB_PASSWORD__'));
  const a1 = first && answer(first);
  const d1 = a1 && a1.hookSpecificOutput && a1.hookSpecificOutput.decision;
  check('marker command: zn answered deny with its reason', !!d1 && d1.behavior === 'deny' && /zn run/.test(d1.message || ''), d1 ? d1.behavior : 'no call');
  const second = pr.find((s) => String(s.input.tool_input && s.input.tool_input.command).includes('ran-after-approval'));
  check('ordinary command: zn gave no answer', !!second && answer(second) === null);
  check('zn never answered allow', !spy.some((s) => /"behavior":"allow"|"permissionDecision":"allow"/.test(s.stdout)));
  check('PreToolUse was not installed for this run (the approval hook alone decides)', ofEvent('PreToolUse').length === 0);
  const declined = Number(read(path.join(OUT, 'tui_declined.txt')).trim());
  check('the user was asked only for the ordinary command (declined once)', declined === 1, declined + ' approval prompt(s) shown');
  const outs = toolOutputs();
  const tui = read(path.join(OUT, 'tui.txt'));
  check('the marker command did not run (the model got the deny reason)', outs.length >= 1 && /zn run/.test(outs[0]) && !/^db:/m.test(outs[0]), outs[0] ? redact(outs[0]).replace(/\s+/g, ' ').slice(0, 200) : 'no output');
  check('the screen showed the approval prompt for the ordinary command only, and it was declined', /Would you like to run/.test(tui) && /canceled the request to run node -e "console.log\('ran-after-approval'\)"/.test(tui) && (tui.match(/Would you like to run/g) || []).length === 1);
  check('the ordinary command did not run', !outs.some((o) => /^ran-after-approval/m.test(o)) && !/\nran-after-approval/.test(tui.replace(/node -e[^\n]*/g, '')), outs.length + ' result(s) after the first');
}

if (SCEN === 'mcp') {
  const pre = ofEvent('PreToolUse').filter((s) => /^mcp__/.test(s.input.tool_name));
  check('PreToolUse fired for the three MCP calls', pre.length === 3, pre.length + ' call(s), tool ' + (pre[0] && pre[0].input.tool_name));
  const denies = pre.map((s) => { const a = answer(s); return !!a && a.hookSpecificOutput && a.hookSpecificOutput.permissionDecision === 'deny'; });
  check('placeholder call denied, secret-value call denied, plain call not answered', denies.join() === 'true,true,false', denies.join());
  const log = lines(path.join(OUT, 'echo_mcp.jsonl'));
  check('only the plain call reached the MCP server', log.length === 1 && /hello from/.test(JSON.stringify(log[0])), log.length + ' call(s) received');
  const seen = read(path.join(OUT, 'echo_mcp.jsonl'));
  check('no secret value or placeholder reached the MCP server', !hasValue(seen) && !/__ZN_/.test(seen));
  const outs = toolOutputs();
  check('the model got the deny reason for the blocked calls', outs.length >= 3 && /zn:/.test(outs[0]) && /zn:/.test(outs[1]), outs.length + ' result(s)');
}

if (SCEN === 'stop-warn') {
  const st = ofEvent('Stop');
  check('Stop fired once with the final answer', st.length === 1 && typeof st[0].input.last_assistant_message === 'string', st.length + ' call(s)');
  const a = st[0] && answer(st[0]);
  check('zn warned with systemMessage and did not block', !!a && typeof a.systemMessage === 'string' && !a.decision, a ? Object.keys(a).join(',') : 'no answer');
  check('the agent did not continue (one turn to the provider)', mainReqs.length === 1, mainReqs.length + ' turn(s)');
  check('the warning does not carry the value', !!a && !hasValue(a.systemMessage || ''));
  info('the answer reached the user unchanged; turns to the provider: ' + mainReqs.length);
  const shown = read(path.join(OUT, 'codex_events.jsonl')) + read(path.join(OUT, 'codex_stderr.txt'));
  info('warning shown by codex exec: ' + (/zn: the last answer contains/.test(shown) ? 'yes' : 'no'));
}

if (SCEN === 'stop-block') {
  const st = ofEvent('Stop');
  check('Stop fired twice (answer, then the rewritten answer)', st.length === 2, st.length + ' call(s)');
  const a1 = st[0] && answer(st[0]);
  check('first answer: zn blocked with a reason', !!a1 && a1.decision === 'block' && /zn:/.test(a1.reason || ''), a1 ? a1.decision : 'no answer');
  check('second call has stop_hook_active and zn did not block again', !!st[1] && st[1].input.stop_hook_active === true && !(answer(st[1]) || {}).decision);
  check('the model got the reason as a new prompt', /zn: your last answer contains/.test(allInputText()));
  check('two turns to the provider', mainReqs.length === 2, mainReqs.length + ' turn(s)');
}

if (SCEN === 'stop-placeholder') {
  const st = ofEvent('Stop');
  const a = st[0] && answer(st[0]);
  info('Stop fired ' + st.length + ' time(s); zn answered: ' + (a ? JSON.stringify(a).slice(0, 200) : 'nothing'));
  const tr = read(path.join(OUT, 'transcripts_count.txt')).trim();
  info('times the placeholder is in the session log: ' + (tr || 'unknown'));
}

if (SCEN === 'replace') {
  const post = ofEvent('PostToolUse');
  check('PostToolUse fired for the read', post.length >= 1, post.length + ' call(s)');
  const a = post[0] && answer(post[0]);
  check('zn answered block with continue false and a stop reason', !!a && a.decision === 'block' && a.continue === false && /zn: this tool output contained/.test(a.stopReason || ''), a ? Object.keys(a).join(',') : 'no answer');
  const outs = toolOutputs();
  check('the model got a result without the values', outs.length >= 1 && !hasValue(outs[0]), outs[0] ? redact(outs[0]).replace(/\s+/g, ' ').slice(0, 200) : 'no result');
  info('result the model got: ' + (outs[0] ? redact(outs[0]).replace(/\s+/g, ' ').slice(0, 300) : 'none') + '; turns to the provider: ' + mainReqs.length);
}

if (SCEN === 'session-context') {
  const CONTEXT = /zn is on in this project/;
  const ss = ofEvent('SessionStart');
  check('SessionStart fired once', ss.length === 1, ss.length + ' call(s), source ' + (ss[0] && ss[0].input.source));
  const a = ss[0] && answer(ss[0]);
  const o = a && a.hookSpecificOutput;
  check('zn answered with additionalContext and nothing that stops', !!o && o.hookEventName === 'SessionStart' && CONTEXT.test(o.additionalContext || '') && a.continue === undefined && !a.decision, a ? Object.keys(a).join(',') : 'no answer');
  const parentReqs = reqs.filter((r) => r.body && Array.isArray(r.body.input) && JSON.stringify(r.body.input).includes('Follow the setup task.') && Array.isArray(r.body.tools) && r.body.tools.length);
  check('the reminder reached the model (the first request to the provider holds it)', parentReqs.length > 0 && CONTEXT.test(JSON.stringify(parentReqs[0].body.input)), parentReqs.length + ' request(s)');
  const notes = lines(path.join(OUT, 'mock_notes.jsonl'));
  const offered = notes.length ? notes[0].offered : [];
  info('tools offered to the model: ' + offered.join(', '));
  const childNotes = notes.filter((r) => r.child);
  info('requests from a subagent reached the provider: ' + childNotes.length);
  const sub = ofEvent('SubagentStart');
  info('SubagentStart hook calls: ' + sub.length + (sub[0] ? '; agent_type ' + sub[0].input.agent_type + '; zn answered ' + JSON.stringify(answer(sub[0])).slice(0, 300) : ''));
  if (sub.length) {
    const sa = answer(sub[0]);
    check('SubagentStart: zn answered with additionalContext for SubagentStart', !!sa && sa.hookSpecificOutput && sa.hookSpecificOutput.hookEventName === 'SubagentStart' && CONTEXT.test(sa.hookSpecificOutput.additionalContext || ''));
    const childReqs = reqs.filter((r) => r.body && Array.isArray(r.body.input) && !JSON.stringify(r.body.input).includes('Follow the setup task.') && Array.isArray(r.body.tools) && r.body.tools.length);
    info('the reminder reached the subagent model: ' + (childReqs.length && CONTEXT.test(JSON.stringify(childReqs[0].body.input)) ? 'yes' : 'no') + ' (' + childReqs.length + ' subagent request(s))');
  }
  const childPre = ofEvent('PreToolUse').filter((s) => /credentials/.test(String(s.input.tool_input && s.input.tool_input.command)));
  info("the subagent's own tool call (cat ~/.aws/credentials) went through zn's PreToolUse: " + (childPre.length ? 'yes, ' + childPre.length + ' call(s), session_id ' + childPre.map((s) => s.input.session_id).join(',') + ', zn answered ' + (answer(childPre[0]) ? 'deny' : 'nothing') : 'no'));
  info('all PreToolUse session ids: ' + [...new Set(ofEvent('PreToolUse').map((s) => s.input.session_id))].join(','));
}

if (SCEN === 'thirdparty') {
  const third = lines(path.join(OUT, 'third_party.jsonl'));
  const pre = ofEvent('PreToolUse');
  info('the other hook saw: ' + third.map((t) => t.event + ' ' + t.command).join(' | '));
  info('zn saw: ' + pre.map((s) => s.input.tool_input && s.input.tool_input.command).join(' | ') + ' (zn answered: ' + pre.map((s) => (answer(s) ? 'deny' : 'nothing')).join(',') + ')');
  const outs = toolOutputs();
  info('what the model got back: ' + (outs[0] ? redact(outs[0]).replace(/\s+/g, ' ').slice(0, 300) : 'none'));
  const post = ofEvent('PostToolUse');
  const ranCmd = post[0] && post[0].input.tool_input && post[0].input.tool_input.command;
  info('PostToolUse saw command: ' + post.map((s) => s.input.tool_input && s.input.tool_input.command).join(' | '));
  info('command ran as rewritten: ' + (ranCmd && ranCmd !== 'echo benign-ok' ? 'yes' : 'no'));
  check('PostToolUse saw the command that really ran, not the original', !!ranCmd && ranCmd !== 'echo benign-ok', String(ranCmd));
  const pa = post[0] && answer(post[0]);
  check('zn answered block and withheld the output', !!pa && pa.decision === 'block' && /withheld/.test(pa.reason || ''), pa ? Object.keys(pa).join(',') : 'no answer');
  check('the model got the withheld message, not the file content', outs.length >= 1 && /withheld/.test(outs[0]) && !hasValue(outs[0]) && !/aws_access_key_id/.test(outs[0]), outs[0] ? redact(outs[0]).replace(/\s+/g, ' ').slice(0, 120) : 'no result');
}

fs.writeFileSync(path.join(OUT, 'checks.txt'), report.join('\n') + '\n');
process.stdout.write(report.join('\n') + '\n');
process.exitCode = failed ? 1 : 0;
