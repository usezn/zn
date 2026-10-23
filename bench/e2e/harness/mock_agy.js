#!/usr/bin/env node
'use strict';
/**
 * A stand-in for the Antigravity CLI, used only to self-test the kit (MODE=selftest of run_antigravity_vm.sh): it
 * needs no account and no model. It reads the task from the prompt with a few patterns, makes the tool call a
 * model would make, asks the hooks (user: $HOME/.gemini/config/hooks.json, project: ./.agents/hooks.json, plugins:
 * $HOME/.gemini/antigravity-cli/plugins/<name>/hooks.json) the way the documentation says Antigravity does
 * (the command split on spaces, no shell, the event on stdin, a decision on stdout), runs the call unless a hook
 * denies it, and prints stream-json events.
 *
 * It is NOT evidence about agy: it only shows that the kit's scripts, spy and checks work end to end. A hook that
 * fails, times out or answers with no decision is treated as a deny, which is what Antigravity was seen to do on
 * Windows; the real behaviour on Linux is what the real run records.
 *
 *   node mock_agy.js [--version | models | plugin install <dir> | plugin list | -p <prompt> [flags]]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const HOME = process.env.HOME || os.homedir();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (argv[0] === '--version') { console.log('mock-agy 0.0.0 (kit self-test, not Antigravity)'); process.exit(0); }
if (argv[0] === 'models') { console.log('mock-model\tMock'); process.exit(0); }
if (argv[0] === 'plugin') {
  const dst = path.join(HOME, '.gemini', 'antigravity-cli', 'plugins');
  if (argv[1] === 'install') {
    const src = argv[2];
    const name = JSON.parse(fs.readFileSync(path.join(src, 'plugin.json'), 'utf8')).name;
    fs.mkdirSync(path.join(dst, name), { recursive: true });
    for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, name, f));
    console.log('installed ' + name);
  } else if (fs.existsSync(dst)) console.log(fs.readdirSync(dst).join('\n'));
  process.exit(0);
}
const pi = argv.findIndex((a) => a === '-p' || a === '--print' || a === '--prompt');
if (pi < 0) { console.error('mock-agy: only -p is supported'); process.exit(2); }
const prompt = argv[pi + 1] || '';
const cwd = process.cwd();

function loadHooks() {
  const files = [path.join(HOME, '.gemini', 'config', 'hooks.json'), path.join(cwd, '.agents', 'hooks.json')];
  const pdir = path.join(HOME, '.gemini', 'antigravity-cli', 'plugins');
  if (fs.existsSync(pdir)) for (const n of fs.readdirSync(pdir)) files.push(path.join(pdir, n, 'hooks.json'));
  const list = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
    for (const e of Object.values(d)) {
      if (!e || e.enabled === false) continue;
      for (const g of e.PreToolUse || []) for (const h of g.hooks || []) list.push({ matcher: g.matcher || '*', command: h.command, timeout: h.timeout || 30 });
    }
  }
  return list;
}

function askHooks(name, args) {
  const event = JSON.stringify({ conversationId: 'mock', workspacePaths: [cwd], transcriptPath: '', artifactDirectoryPath: '', modelName: 'mock', stepIdx: 0, toolCall: { name, args } });
  let verdict = 'allow';
  let reason = '';
  for (const h of loadHooks()) {
    if (!(h.matcher === '*' || h.matcher === '' || new RegExp(h.matcher).test(name))) continue;
    const parts = h.command.split(' ').filter(Boolean);
    const r = spawnSync(parts[0], parts.slice(1), { input: event, encoding: 'utf8', timeout: h.timeout * 1000, env: process.env });
    let d = null;
    try { d = JSON.parse(String(r.stdout || '').trim()); } catch (_) { /* no decision */ }
    if (r.error || !d || !d.decision) { verdict = 'deny'; reason = 'hook failed'; continue; }
    if (d.decision === 'deny') { verdict = 'deny'; reason = d.reason || ''; }
  }
  return { verdict, reason };
}

const P = (...p) => path.join(cwd, ...p);
function plan() {
  const calls = [];
  const sh = (c) => calls.push({ name: 'run_command', args: { CommandLine: c, Cwd: cwd } });
  if (/echo zn-e2e-harmless/.test(prompt)) sh('echo zn-e2e-harmless > harmless.txt');
  else if (/echo zn-e2e-project/.test(prompt)) sh('echo zn-e2e-project > project.txt');
  else if (/\.agents\/hooks\.json/.test(prompt)) calls.push({ name: 'write_to_file', args: { TargetFile: P('.agents', 'hooks.json'), CodeContent: '{}' } });
  else if (/rm -rf \.\/fake-dir/.test(prompt)) sh('rm -rf ./fake-dir');
  else if (/rm -rf ~\/\*/.test(prompt)) sh('rm -rf ~/*');
  else if (/touch fail-marker\.txt/.test(prompt)) sh('touch fail-marker.txt');
  else if (/cat \.env/.test(prompt)) sh('cat .env');
  else if (/contents of the file \.env/.test(prompt)) calls.push({ name: 'view_file', args: { AbsolutePath: P('.env') } });
  else if (/MCP tool named echo|echo tool/.test(prompt)) calls.push({ name: 'mcp_echo_echo', args: { text: 'zn-e2e-mcp' } });
  else if (/notes\.txt/.test(prompt)) {
    calls.push({ name: 'read_file', args: { Path: P('src', 'index.js') } });
    calls.push({ name: 'write_file', args: { Path: P('notes.txt'), Content: 'hello' } });
    calls.push({ name: 'edit_file', args: { Path: P('notes.txt'), Target: 'hello', Replacement: 'goodbye' } });
    calls.push({ name: 'list_dir', args: { DirectoryPath: P('src') } });
    calls.push({ name: 'grep_search', args: { SearchPath: P('src'), Query: 'hello' } });
  }
  return calls;
}

out({ event: 'init', conversation_id: 'mock' });
let answer = 'DONE';
for (const c of plan()) {
  const { verdict, reason } = askHooks(c.name, c.args);
  if (verdict === 'deny') {
    out({ event: 'step_update', tool: c.name, args: c.args, status: 'denied', error: 'Blocked by hook: ' + reason });
    answer = 'The call was blocked: ' + reason;
    continue;
  }
  let result = '';
  try {
    if (c.name === 'run_command') {
      const r = spawnSync('sh', ['-c', c.args.CommandLine], { cwd, encoding: 'utf8' });
      result = String(r.stdout || '') + String(r.stderr || '');
    } else if (c.name === 'view_file' || c.name === 'read_file') result = fs.readFileSync(c.args.AbsolutePath || c.args.Path, 'utf8');
    else if (c.name === 'write_to_file' || c.name === 'write_file') {
      const f = c.args.TargetFile || c.args.Path;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, c.args.CodeContent || c.args.Content || '');
    }
  } catch (e) { result = String(e.message); }
  out({ event: 'step_update', tool: c.name, args: c.args, status: 'done', output: result });
  if (c.name === 'view_file') answer = result;
}
out({ event: 'result', status: 'SUCCESS', response: answer });
