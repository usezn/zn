'use strict';

/**
 * GitHub Copilot adapter: Copilot in VS Code and GitHub Copilot CLI. Supported.
 *
 * VS Code documents that "VS Code, the GitHub Copilot app, and GitHub Copilot CLI share this harness and its hook
 * format" (https://code.visualstudio.com/docs/copilot/customization/hooks, section "Copilot harness"; read 2026-10-30,
 * hooks in VS Code are in Preview). The same page lists what that harness loads: "User hook files in ~/.copilot/hooks/, or
 * $COPILOT_HOME/hooks/ when COPILOT_HOME is set" and ".github/hooks/*.json at the repository root", with "version": 1,
 * "type": "command", the platform commands "bash" / "powershell" and "timeoutSec", and the events preToolUse and
 * postToolUse. The files zn writes are exactly those. Evidence level: documented, and run end to end only with Copilot
 * CLI 1.0.98; not tested in the VS Code app itself.
 *
 * Limits that VS Code and GitHub document, and that no hook format can lift:
 *  - "Timeouts are fail-open for every event, including preToolUse and admin-deployed policy hooks"
 *    (https://docs.github.com/en/copilot/reference/hooks-reference, "Exit codes"). zn does not wait for it: its own
 *    supervisor (runner armSupervisor) answers with a deny 4 s before timeoutSec, so only a hook that is stopped before it
 *    could start its timer (a machine so loaded that Node.js does not start in 11 s) is let through.
 *  - "Command and HTTP config-file userPromptSubmitted hooks have their output dropped, including modifiedPrompt"
 *    (same page, "userPromptSubmitted"): a typed prompt cannot be blocked from a hook file in VS Code or the CLI.
 *  - The Copilot harness also reads the repository .claude/settings(.local).json ("Cross-tool .claude/settings.json ...
 *    files in the repository are also read"; no setting needed: chat.useClaudeHooks is for VS Code's older Local harness) and runs
 *    "Applicable hooks from multiple sources ... together", so zn set up for Claude Code with --project runs twice.
 *    `zn-gate check` says so.
 *
 * Hook format (docs read 2026-10-19 and 2026-10-30):
 *  - https://docs.github.com/en/copilot/reference/hooks-reference
 *  - https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models (custom model endpoint)
 *
 *  Files: Copilot CLI loads every *.json in <project>/.github/hooks/ and in ~/.copilot/hooks/ ($COPILOT_HOME/hooks/
 *  when COPILOT_HOME is set), after the machine policy files (/etc/github-copilot/policy.d/*.json, which no user
 *  setting can switch off). zn writes its own file, zn-gate.json, in one of those folders and only edits what it
 *  wrote there:
 *    { "version": 1, "hooks": { "preToolUse": [ { "type": "command", "bash": "...", "powershell": "...", "timeoutSec": 15 } ] } }
 *
 *  stdin has two spellings, chosen by the casing of the event name in the hooks file: camelCase (preToolUse:
 *  sessionId, timestamp, cwd, toolName, toolArgs; postToolUse adds toolResult {resultType, textResultForLlm}) and
 *  the VS Code compatible one (PreToolUse: hook_event_name, session_id, tool_name, tool_input, tool_result). The
 *  camelCase payload does not name its event, so zn tells them apart by their fields. zn installs the camelCase keys.
 *  stdout of preToolUse: {permissionDecision: allow | deny | ask, permissionDecisionReason (required for deny)}.
 *  Empty output means "no opinion" (default behaviour), so zn never prints "allow".
 *  stdout of postToolUse: {modifiedResult: {resultType: "success", textResultForLlm}, additionalContext}.
 *  Exit codes: 0 = parse stdout; 2 = deny for preToolUse (a warning for the other events); any other non-zero =
 *  fail-closed for preToolUse and fail-open for the others. A TIMEOUT (default 30 s) always fails OPEN: zn answers first (see above).
 *
 *  Events: preToolUse is checked and can deny (zn also asks for confirmation when it needs one; Copilot turns
 *  "ask" into a deny in the cloud agent and in autopilot). postToolUse replaces secret values in the result of
 *  read-type and shell tools. userPromptSubmitted cannot block or rewrite for command hooks (modifiedPrompt is
 *  honoured only by SDK hooks) and sessionStart can only add context, so zn does not install them; if one arrives
 *  anyway it gets no opinion.
 *
 * Runtime tool names: bash, powershell (CLI only), view, create, edit, grep, glob, web_fetch, task, ask_user. The
 * argument names are not documented on that page, so this adapter finds the command and the files by likely key
 * names (like the Antigravity adapter) and refuses a known tool whose arguments it cannot read. How an MCP tool is
 * named is not documented: a tool zn cannot classify gets the path checks if it names a file and no opinion
 * otherwise.
 *
 * Checked against a real Copilot CLI 1.0.98 (bench/e2e/harness/run_copilot.sh, scripted provider): tool names bash, view,
 * create with the arguments command, path, file_text; a deny is shown to the model as "Denied by preToolUse hook: <reason>";
 * postToolUse modifiedResult reaches the model; no secret value reached the provider. Copilot's own events.jsonl keeps the original output.
 *
 * Switching hooks off: "disableAllHooks": true at the top of a hooks file skips that file; in a repository's
 * .github/copilot/settings(.local).json it skips every hook except the policy ones. `zn-gate check` reports both.
 */

const fs = require('fs');
const { fileURLToPath } = require('url');
const os = require('os');
const path = require('path');
const cfg = require('./config-file');
const launcher = require('./launcher');
const { shQuote } = require('../shell-quote');

const id = 'copilot';
const FILE_NAME = 'zn-gate.json';
const HOOK_TIMEOUT_S = 15;
const INSTALL_EVENTS = ['preToolUse', 'postToolUse'];

// The VS Code compatible spelling may carry Claude-style tool names.
const CLAUDE_NAMES = { Bash: 'bash', Read: 'view', Write: 'create', Edit: 'edit', MultiEdit: 'edit', Grep: 'grep', Glob: 'glob', WebFetch: 'web_fetch' };
const SHELL_TOOLS = new Set(['bash', 'powershell']);
const WRITE_TOOLS = new Set(['create', 'edit']);
const KNOWN_TOOLS = new Set(['bash', 'powershell', 'view', 'create', 'edit', 'grep', 'glob', 'web_fetch']);
const COMMAND_KEYS = ['command', 'cmd', 'Command', 'script'];
const PATH_KEY_RE = /path|file|target|uri|dir|source|destination/i;
const NOT_PATH_KEY_RE = /content|text|instruction|description|query|pattern|code|chunk|summary|title|str$/i;
const MAX_PATH_LEN = 4096;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function firstString(obj, keys) {
  for (const k of keys) if (typeof obj[k] === 'string' && obj[k]) return obj[k];
  return undefined;
}

// The text of a patch tool call (VS Code's apply_patch sends {input: "*** Begin Patch ..."}): the tool named
// apply_patch, or any tool with a string argument that starts a patch. undefined = not a patch.
const PATCH_KEYS = ['input', 'patch', 'patchText', 'command', 'text'];
const PATCH_HEAD_RE = /^\*\*\* Begin Patch\b/m;
// The argument objects of a call: the top level, then each object (or object in an array) one level down.
function argLevels(args) {
  const down = [];
  for (const v of Object.values(args)) {
    if (isObj(v)) down.push(v);
    else if (Array.isArray(v)) for (const x of v) if (isObj(x)) down.push(x);
  }
  return [args, ...down];
}
/** {text, key}: the patch text and where it sits in the arguments (top level first, then one level down); undefined = not a patch. */
function patchFound(toolName, args) {
  for (const level of argLevels(args)) {
    const keyOf = (obj, k) => (obj === args ? [k] : null);
    if (toolName === 'apply_patch') {
      const k = PATCH_KEYS.find((x) => typeof level[x] === 'string' && level[x]);
      if (k !== undefined) return { text: level[k], key: level === args ? [k] : null };
      continue;
    }
    const k = Object.keys(level).find((x) => typeof level[x] === 'string' && PATCH_HEAD_RE.test(level[x]));
    if (k !== undefined) return { text: level[k], key: keyOf(level, k) };
  }
  return toolName === 'apply_patch' ? { text: '', key: null } : undefined;
}
function patchTextOf(toolName, args) {
  const f = patchFound(toolName, args);
  return f ? f.text : undefined;
}

/** The write input of a patch: every file it adds, updates, deletes or moves to (the Codex parser), checked like a write. */
function patchInput(text, key) {
  const { patchScan, PATCH_SCAN_CAP } = require('./codex');
  const tooLong = text.length > PATCH_SCAN_CAP;
  const scan = tooLong ? { files: [], suspicious: false } : patchScan(text);
  const files = scan.files;
  return { path: files[0], paths: files, alsoReadCheck: true, tooLong, unparsed: !tooLong && (files.length === 0 || scan.suspicious), texts: key ? [{ key, value: text }] : [] };
}

/**
 * Whether VS Code's shell task builder wraps a plain string argument in strong quotes. Ported from the task system's
 * shell command line builder in the VS Code source (terminalTaskSystem.ts, needsQuotes): an argument that starts and
 * ends with the same quote character is left alone; otherwise it is scanned left to right, quotes open and close a
 * quoted stretch, and only a space outside a quoted stretch asks for quotes (a tab or a newline does not).
 * VS Code compares the character with its escape setting, which is an object for bash and zsh, so a backslash skips
 * nothing there; skipEscape reads the same argument the other way (a backslash skips the next character) so both
 * readings of the line are judged.
 */
function needsQuotes(value, skipEscape) {
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value[0] === value[value.length - 1]) return false;
  let quote;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === quote) quote = undefined;
    else if (quote !== undefined) continue;
    else if (skipEscape && ch === '\\') i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === ' ') return true;
  }
  return false;
}

/**
 * One piece of a task line (a command or an argument) the way VS Code gives it: a string, or {value, quoting} with
 * quoting escape, strong or weak. Returns the text as VS Code puts it on a bash line (vs), the same with a backslash
 * read as an escape (vse), the bare value (raw) and a POSIX-quoted form (q); null when the piece has a shape zn
 * cannot read. VS Code wraps a plain string only when needsQuotes says so, without escaping a quote inside it, and
 * writes {value, quoting} with its own quoting (escape puts a backslash before a space, a double quote, a single
 * quote and a comma).
 */
function taskPiece(x) {
  if (typeof x === 'string') {
    return {
      vs: needsQuotes(x, false) ? "'" + x + "'" : x,
      vse: needsQuotes(x, true) ? "'" + x + "'" : x,
      vw: /\s/.test(x) ? "'" + x + "'" : x,
      raw: x,
      q: shQuote(x),
    };
  }
  if (!isObj(x) || typeof x.value !== 'string') return null;
  const v = x.value;
  const k = x.quoting;
  if (k !== undefined && k !== 'escape' && k !== 'strong' && k !== 'weak') return null;
  const vs = k === 'strong' ? "'" + v + "'" : k === 'weak' ? '"' + v + '"' : k === 'escape' ? v.replace(/[ "',]/g, '\\$&') : v;
  return { vs, vse: vs, vw: vs, raw: v, q: shQuote(v) };
}

/**
 * A command one level down (create_and_run_task sends {task: {command, args}}) as the line(s) it runs.
 * For a shell task the line is built the way VS Code builds it, argument by argument (see needsQuotes), and that line
 * is judged; a newline or tab inside an argument VS Code leaves unquoted stays in the line, so the shell's second
 * command is seen. The same line with a backslash read as an escape, the bare values and every argument quoted are
 * judged as well and the stricter answer wins. With no arguments VS Code runs a string command as typed. A process
 * task has no shell, so each argument is quoted. undefined = no command here; null = a command or argument zn
 * cannot read (never dropped).
 */
function nestedCommand(args) {
  for (const v of Object.values(args)) {
    if (!isObj(v)) continue;
    const key = COMMAND_KEYS.find((k) => v[k] !== undefined);
    if (key === undefined) continue;
    const c = taskPiece(v[key]);
    if (!c || (typeof v[key] === 'string' && !v[key])) return null;
    let extra = [];
    if (v.args !== undefined) {
      if (!Array.isArray(v.args)) return null;
      extra = v.args.map(taskPiece);
      if (extra.some((p) => p === null)) return null;
    }
    const join = (f) => [c, ...extra].map(f).join(' ');
    if (typeof v.type === 'string' && v.type.toLowerCase() === 'process') return join((p) => p.q);
    const bare = typeof v[key] === 'string' && extra.length === 0;
    const lines = [bare ? c.raw : join((p) => p.vs), bare ? c.raw : join((p) => p.vse), bare ? c.raw : join((p) => p.vw), join((p) => p.raw), join((p) => p.q)];
    return lines.filter((l, i, arr) => arr.indexOf(l) === i).join('\n');
  }
  return undefined;
}

// A tool whose name says it changes files: its refusals use the write wording.
const WRITE_NAME_RE = /write|edit|create|replace|insert|patch|delete|remove|move|rename|save|append|overwrite|modify/i;
function isWriteName(name) {
  return WRITE_NAME_RE.test(String(name || ''));
}

// JSON with comments and trailing commas, which is what VS Code's tasks.json is. Throws when it is not.
function parseJsonc(text) {
  let out = '';
  let inStr = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] || ''; i++; } else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      i = end + 1;
      out += ' ';
    } else if (ch === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += ch;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/^﻿/, ''));
}

const RUN_TASK_RE = /^run_?task$/i;
const MAX_TASKS_BYTES = 1024 * 1024;

function dependsLabels(d) {
  const list = Array.isArray(d) ? d : d === undefined ? [] : [d];
  return list.map((x) => (typeof x === 'string' ? x : isObj(x) ? x.task : undefined)).filter((x) => typeof x === 'string');
}

/** The command lines of one task of tasks.json: its command, its per-OS overrides and the tasks it depends on. null = unreadable. */
function taskLines(t, tasks, seen, depth) {
  const lines = [];
  const add = (obj) => {
    const l = nestedCommand({ task: obj });
    if (l === null) return false;
    if (l !== undefined) lines.push(l);
    return true;
  };
  if (!add(t)) return null;
  for (const os of ['windows', 'linux', 'osx']) {
    if (t[os] === undefined) continue;
    if (!isObj(t[os]) || !add({ type: t.type, ...t[os] })) return null;
  }
  if (depth < 5) {
    for (const dep of dependsLabels(t.dependsOn)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const d = tasks.find((x) => isObj(x) && (x.label === dep || x.taskName === dep));
      if (!d) continue;
      const sub = taskLines(d, tasks, seen, depth + 1);
      if (sub === null) return null;
      if (sub !== undefined) lines.push(sub);
    }
  }
  return lines.length ? lines.join('\n') : undefined;
}

/**
 * run_task runs a task that already exists, named by id, so its input holds no command. The task is read from the
 * workspace's .vscode/tasks.json as it is on disk now (so a task written earlier in the same turn is judged by what was
 * written) and its command lines are returned like nestedCommand's. undefined = not a run_task call, or a task that is
 * not in tasks.json (a built-in or extension task, such as npm: test); null = the call or the file cannot be read.
 */
function taskCommand(toolName, args, cwd) {
  if (!RUN_TASK_RE.test(String(toolName || ''))) return undefined;
  const id = firstString(args, ['id', 'label', 'taskId', 'task', 'name']);
  if (id === undefined) return null;
  let ws = firstString(args, ['workspaceFolder', 'workspace', 'cwd', 'folder']) || cwd;
  if (/^file:/i.test(ws)) {
    try { ws = fileURLToPath(ws); } catch (_) { return null; }
  }
  const file = path.join(path.resolve(cwd, ws), '.vscode', 'tasks.json');
  let text;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > MAX_TASKS_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? undefined : null;
  }
  let data;
  try { data = parseJsonc(text); } catch (_) { return null; }
  if (!isObj(data)) return null;
  if (data.tasks === undefined) return undefined;
  if (!Array.isArray(data.tasks)) return null;
  const names = [id, id.replace(/^[^:]+:\s*/, '')];
  const t = data.tasks.find((x) => isObj(x) && (names.includes(x.label) || names.includes(x.taskName)));
  if (!t) return undefined;
  return taskLines(t, data.tasks, new Set([id]), 0);
}

function nestedOrTask(rawName, args, cwd) {
  const t = taskCommand(rawName, args, cwd);
  return t !== undefined ? t : nestedCommand(args);
}

/** Every string argument whose key looks like a file or folder (content-like keys skipped), three levels deep. */
function pathsOf(args) {
  const out = [];
  let bad = false;
  const add = (k, v) => {
    if (typeof v !== 'string' || !v) return;
    if (/^file:/i.test(v)) {
      try { out.push(fileURLToPath(v)); } catch (_) { bad = true; }
      return;
    }
    if (/url/i.test(k) && !PATH_KEY_RE.test(k)) return;
    if (v.length > MAX_PATH_LEN || /[\r\n]/.test(v)) return;
    out.push(v);
  };
  const keyOk = (k) => (PATH_KEY_RE.test(k) || /url/i.test(k)) && !NOT_PATH_KEY_RE.test(k);
  const walk = (obj, depth) => {
    for (const [k, v] of Object.entries(obj)) {
      if (keyOk(k)) {
        if (Array.isArray(v)) v.forEach((x) => add(k, x)); else add(k, v);
      }
      if (depth < 3) {
        if (isObj(v)) walk(v, depth + 1);
        else if (Array.isArray(v)) v.forEach((x) => { if (isObj(x)) walk(x, depth + 1); });
      }
    }
  };
  walk(args, 0);
  return { paths: out, bad };
}

/** The event of a payload: the casing of the hooks file picks the spelling, and the camelCase one has no event name. */
function eventName(raw) {
  const named = raw.hook_event_name || raw.hookEventName;
  if (typeof named === 'string' && named) return named.charAt(0).toLowerCase() + named.slice(1);
  const has = (k) => raw[k] !== undefined && raw[k] !== null;
  if (has('toolResult') || has('tool_result')) return 'postToolUse';
  if (has('toolName') || has('tool_name') || has('toolArgs') || has('tool_input')) return has('error') ? 'postToolUseFailure' : 'preToolUse';
  if (typeof raw.prompt === 'string') return 'userPromptSubmitted';
  if (has('source')) return 'sessionStart';
  return null;
}

/** toolArgs / tool_input as an object. A JSON string is parsed too. null = could not be read. */
function argsOf(raw) {
  let a = raw.toolArgs !== undefined ? raw.toolArgs : raw.tool_input;
  if (a === undefined || a === null) return {};
  if (typeof a === 'string') {
    try { a = JSON.parse(a); } catch (_) { return null; }
  }
  return isObj(a) ? a : null;
}

function resultText(raw) {
  const r = raw.toolResult !== undefined ? raw.toolResult : raw.tool_result;
  if (!isObj(r)) return undefined;
  const type = r.resultType !== undefined ? r.resultType : r.result_type;
  const text = r.textResultForLlm !== undefined ? r.textResultForLlm : r.text_result_for_llm;
  // Only a successful result is rewritten: modifiedResult must say "success", so it cannot stand in for a failure.
  return type === 'success' && typeof text === 'string' ? text : undefined;
}

function normalize(raw) {
  if (!isObj(raw)) return null;
  const cwd = typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : process.cwd();
  const base = { cwd, sessionId: raw.sessionId || raw.session_id || null, raw };
  const name = eventName(raw);
  if (name !== 'preToolUse' && name !== 'postToolUse') return { ...base, event: null };
  const rawName = String(raw.toolName !== undefined ? raw.toolName : raw.tool_name || '');
  const toolName = CLAUDE_NAMES[rawName] || rawName.toLowerCase();
  const args = argsOf(raw);
  const event = name === 'preToolUse' ? 'pre_tool' : 'post_tool';
  const ev = { ...base, event, toolName, rawArgs: args || {} };
  if (event === 'pre_tool' && !rawName) return { ...ev, tool: 'unreadable', input: { texts: [] }, unreadable: 'zn: could not read the tool name of this call, so zn cannot check it.' };
  if (event === 'post_tool') ev.output = resultText(raw);
  const unreadable = (what) => 'zn: could not read the ' + what + ' of this call, so zn cannot check it.';

  const known = KNOWN_TOOLS.has(toolName);
  if (args === null) {
    return { ...ev, tool: toolName || 'unknown', input: { texts: [] }, ...(known ? { unreadable: unreadable('arguments') } : {}) };
  }
  if (!known) {
    const found = patchFound(toolName, args);
    if (found) return { ...ev, tool: 'write', input: patchInput(found.text, found.key) };
  }
  let cmd = firstString(args, COMMAND_KEYS) !== undefined ? firstString(args, COMMAND_KEYS) : (known ? undefined : nestedOrTask(rawName, args, cwd));
  const nestedBad = cmd === null;
  if (nestedBad) cmd = undefined;
  if (SHELL_TOOLS.has(toolName) || nestedBad || (!known && cmd !== undefined)) {
    const e = { ...ev, tool: toolName === 'powershell' ? 'powershell' : 'bash', input: { command: cmd || '', texts: [] } };
    if (cmd === undefined) e.unreadable = unreadable('command');
    return e;
  }
  const { paths, bad } = pathsOf(args);
  const input = { path: paths[0], paths, texts: [] };
  const kind = toolName === 'view' ? 'read' : toolName === 'grep' ? 'grep' : WRITE_TOOLS.has(toolName) ? 'write' : null;
  if (kind) {
    const searchDir = kind === 'grep' ? (paths[0] ? path.resolve(cwd, paths[0]) : cwd) : null;
    const e = { ...ev, tool: kind, input: searchDir ? { ...input, scanDir: searchDir } : input };
    if (bad) e.unreadable = unreadable('file address');
    else if (kind !== 'grep' && !paths.length) e.unreadable = unreadable('file');
    return e;
  }
  if (toolName === 'web_fetch') {
    const url = firstString(args, ['url', 'uri', 'URL']);
    return { ...ev, tool: 'webfetch', input: { url: url || '', texts: [] } };
  }
  // glob lists names only. Any other tool that names a file (a plugin, an MCP server, a future tool) gets the read
  // and write checks on every path in it; tools with no path get no opinion.
  if (toolName !== 'glob' && (paths.length || bad)) {
    const e = { ...ev, tool: 'fileaccess', input: isWriteName(toolName) ? { ...input, intent: 'write' } : input };
    if (bad) e.unreadable = unreadable('file address');
    return e;
  }
  return { ...ev, tool: toolName || 'unknown', input: { texts: [] } };
}

function respond(d) {
  const ev = d && d.event;
  if (!ev || !ev.event) return null; // no opinion: empty output
  if (ev.event === 'post_tool') {
    if (typeof d.updatedOutput !== 'string') return null;
    const o = { modifiedResult: { resultType: 'success', textResultForLlm: d.updatedOutput } };
    if (d.message) o.additionalContext = d.message;
    return o;
  }
  const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason });
  if (d.decision === 'deny') return deny(d.message || 'Blocked by zn');
  if (ev.unreadable) return deny(ev.unreadable);
  if (d.updatedInput && d.kind === 'wrap') {
    return deny('zn: this command uses a stored secret. Run it through zn instead, exactly like this: zn run -- ' + ev.input.command +
      '  (zn puts the value only into that process, if the user allowed this command for the secret).');
  }
  // A rewritten command is not applied (the argument names are not documented): the user is asked about the
  // original instead. Copilot turns "ask" into a deny where nobody can answer (cloud agent, autopilot).
  if (d.decision === 'ask' || d.updatedInput) return { permissionDecision: 'ask', permissionDecisionReason: d.message || 'zn asks for confirmation' };
  return null; // never "allow": zn has no opinion and Copilot's own permission rules decide
}

/* ------------------------ install / uninstall ---------------------- */

/** Copilot's user folder: $COPILOT_HOME, else ~/.copilot. */
function copilotHome(opts = {}) {
  const env = opts.env || process.env;
  return env.COPILOT_HOME || path.join(opts.home || os.homedir(), '.copilot');
}

function hooksFile(opts = {}) {
  if ((opts.scope || 'user') === 'project') return path.join(path.resolve(opts.projectDir || process.cwd()), '.github', 'hooks', FILE_NAME);
  return path.join(copilotHome(opts), 'hooks', FILE_NAME);
}

const handlerIsOurs = (h) => isObj(h) && ['bash', 'powershell', 'command'].some((k) => cfg.isOurs(h[k], id));

/** Removes zn's handlers from a hooks file's data; true when something was removed. */
function stripOurs(data) {
  if (!isObj(data.hooks)) return false;
  let changed = false;
  for (const event of Object.keys(data.hooks)) {
    const list = data.hooks[event];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((h) => !handlerIsOurs(h));
    if (kept.length !== list.length) changed = true;
    if (kept.length) data.hooks[event] = kept; else delete data.hooks[event];
  }
  return changed;
}

function install(opts = {}) {
  const file = hooksFile(opts);
  const project = (opts.scope || 'user') === 'project';
  const data = cfg.readJson(file);
  if (data.version !== undefined && data.version !== 1) throw new Error(file + ' has "version": ' + JSON.stringify(data.version) + ', not 1 (left unchanged)');
  cfg.hooksOf(data, file);
  const report = { settings: file, backup: cfg.backup(file), warnings: [] };
  if (report.backup && project) report.warnings.push('The backup ' + report.backup + ' sits inside the project: do not commit it.');
  stripOurs(data);
  const platform = opts.platform || process.platform;
  // A project install runs `zn` from the PATH inside zn's start guard (launcher.projectShCommand / projectWindowsScript): a missing zn or Node.js denies the call.
  const guarded = project && !opts.command;
  const bash = cfg.hookCommand(id, opts);
  const handlerFor = (event) => {
    if (guarded) return { type: 'command', bash: launcher.projectShCommand(id, event), powershell: launcher.windowsScriptCommand(launcher.projectWindowsScript(id, event)), timeoutSec: HOOK_TIMEOUT_S };
    const h = { type: 'command', bash, timeoutSec: HOOK_TIMEOUT_S };
    if (opts.command) h.powershell = opts.command;
    else if (project) h.powershell = bash;
    else if (platform === 'win32') h.powershell = cfg.hookCommandWindows(id, opts);
    return h;
  };
  data.version = 1;
  if (!isObj(data.hooks)) data.hooks = {};
  // "disableAllHooks" in a file zn wrote would switch its own hook off: an install turns it back on.
  if (data.disableAllHooks === true) {
    delete data.disableAllHooks;
    report.warnings.push('"disableAllHooks" was true in this file and was removed: it switched every hook of the file off.');
  }
  for (const event of INSTALL_EVENTS) {
    const list = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    data.hooks[event] = [...list, handlerFor(event)];
  }
  cfg.writeJson(file, data);
  report.warnings.push('GitHub Copilot (VS Code and Copilot CLI) reads this file. zn checks tool calls before they run (preToolUse): it blocks reads and writes of secret files and shell commands that handle secrets, and it replaces secret values in the results of read-type and shell tools (postToolUse).');
  report.warnings.push('Copilot keeps its own session log (events.jsonl) with the original tool output on this machine: zn replaces secret values in what goes to the model, not in that local log.');
  report.warnings.push('Copilot drops the output of a command hook for a typed prompt (userPromptSubmitted), in VS Code and in Copilot CLI, so a secret pasted into a prompt is not stopped.');
  report.warnings.push('The hooks follow the VS Code and GitHub documentation; they were run end to end with Copilot CLI, not inside the VS Code app.');
  report.warnings.push('Copilot lets a call through when a hook times out (30 s by default; zn asks for ' + HOOK_TIMEOUT_S + ' s and blocks the call itself 4 s earlier), and its machine policy files (/etc/github-copilot/policy.d, or the Windows policy folder) are loaded in addition to this one.');
  if (project && !opts.command) report.warnings.push('The project hook runs `zn` from your PATH (zn hook copilot): every teammate who opens this project in Copilot CLI needs zn-gate installed, otherwise the hook cannot start. Copilot also asks each person to trust the folder before it runs repository hooks.');
  return report;
}

function uninstall(opts = {}) {
  const file = hooksFile(opts);
  const report = { settings: file, backup: null, removed: 0, warnings: [] };
  if (!fs.existsSync(file)) return report;
  const data = cfg.readJson(file);
  const before = JSON.stringify(data);
  if (!stripOurs(data) || JSON.stringify(data) === before) return report;
  report.backup = cfg.backup(file);
  report.removed = 1;
  const hooksLeft = isObj(data.hooks) ? Object.keys(data.hooks).length : 0;
  const others = Object.keys(data).filter((k) => k !== 'version' && k !== 'hooks' && k !== 'disableAllHooks');
  if (!hooksLeft && !others.length) {
    fs.unlinkSync(file);
  } else {
    if (!hooksLeft) delete data.hooks;
    cfg.writeJson(file, data);
  }
  return report;
}

function detect(opts = {}) {
  return fs.existsSync(copilotHome(opts));
}

module.exports = {
  id,
  HOOK_TIMEOUT_S,
  detect,
  install,
  uninstall,
  normalize,
  respond,
  capabilities: { ask: 'interactive', rewriteInput: false, rewriteOutput: true },
  hooksFile,
  copilotHome,
  pathsOf,
  firstString,
  COMMAND_KEYS,
  patchTextOf,
  patchFound,
  patchInput,
  nestedCommand,
  taskCommand,
  nestedOrTask,
  isWriteName,
};
