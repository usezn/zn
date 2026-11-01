'use strict';
// Options of the scan and analyze commands. bin/cli.js uses them, and the tests check every value option.
// Any other option that starts with "--" is refused with exit 2: it is named and the options the command takes
// are listed. Everything after a bare "--" is positional text, and so is anything that does not start with "--"
// (analyze text may start with "-").
//
// A value option takes its value as the next argument (--format json) or after an equals sign (--format=json),
// as the Python CLI does. Both forms are read the same way: expandEqualsOptions rewrites --name=value into
// --name value before the rest of the parser runs, so no other code needs to know about the equals form.

const CLOUD_VALUE_OPTIONS = ['--key', '--stage', '--url', '--long-input'];
const CLOUD_FLAG_OPTIONS = ['--local-only', '--verbose'];
const COMMAND_OPTIONS = {
  scan: {
    value: ['--format', '--include', '--exclude', ...CLOUD_VALUE_OPTIONS],
    flag: ['--code', '--all', '--allow-partial', '--include-home', ...CLOUD_FLAG_OPTIONS],
    listed: ['--format', '--include', '--exclude', '--code', '--all', '--allow-partial', '--include-home'],
  },
  analyze: {
    value: CLOUD_VALUE_OPTIONS,
    flag: CLOUD_FLAG_OPTIONS,
    listed: CLOUD_VALUE_OPTIONS.concat(CLOUD_FLAG_OPTIONS),
  },
};

// The arguments of scan or analyze with every --name=value of a value option split into --name and value.
// A value after a bare "--" is positional text and is left alone, and so is the value that follows --name
// in the spaced form, whatever it looks like. An empty value (--format=) becomes --format "" , which is
// what --format "" has always meant.
function expandEqualsOptions(command, args) {
  const spec = COMMAND_OPTIONS[command];
  if (!spec) return args.slice();
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--') {
      out.push(...args.slice(i));
      break;
    }
    if (!tok.startsWith('--')) {
      out.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq === -1 ? tok : tok.slice(0, eq);
    if (!spec.value.includes(name)) {
      out.push(tok);
      continue;
    }
    if (eq !== -1) {
      out.push(name, tok.slice(eq + 1));
      continue;
    }
    out.push(tok);
    if (i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

// The problem with an option of scan or analyze, or null when every option is one the command takes.
// Takes the arguments after expandEqualsOptions, so a value option never carries an equals sign here.
function optionProblem(command, args) {
  const spec = COMMAND_OPTIONS[command];
  for (let i = 1; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--') break;
    if (!tok.startsWith('--')) continue;
    const name = tok.split('=')[0];
    const shown = tok.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
    const takesValue = spec.value.includes(name);
    if (!takesValue && !spec.flag.includes(name)) {
      let msg = 'unknown option "' + shown + '". The options of zn-gate ' + command + ' are ' + spec.listed.join(', ') + '.';
      if (command === 'analyze') msg += ' To analyze text that starts with "--", put "--" before it: zn-gate analyze -- "<text>".';
      return msg;
    }
    if (tok !== name) return name + ' takes no value.';
    if (takesValue) i++;
  }
  return null;
}

// The folder that scan audits: the first argument that is not an option or an option's value; "." when none.
function scanTargetOf(args) {
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--') return args[i + 1] || '.';
    if (!args[i].startsWith('--')) return args[i];
    if (COMMAND_OPTIONS.scan.value.includes(args[i])) i++;
  }
  return '.';
}

// Commands whose options are checked by name before they run. Each command reads its own values, so only the names
// are listed here: the options its handler and docs/cli.md give it. -h, --help, -V and --version are always accepted.
const CLOUD_OPTIONS = CLOUD_VALUE_OPTIONS.concat(CLOUD_FLAG_OPTIONS);
const EVIDENCE_OPTIONS = ['--verify', '--ui', '--export', '--format', '--output', '--port', '--tail'];
const SHIELD_OPTIONS = CLOUD_OPTIONS.concat(['--shadow']);
const SECRET_SET_OPTIONS =['--mode', '--in', '--host', '--command', '--type', '--force', '--clipboard'];
const SIMPLE_OPTIONS = {
  'status': CLOUD_OPTIONS,
  'test': CLOUD_OPTIONS,
  'check': ['--verbose'],
  'doctor': ['--verbose'],
  'version': [],
  'evidence': EVIDENCE_OPTIONS,
  'logs': EVIDENCE_OPTIONS,
  'export': EVIDENCE_OPTIONS,
  'mcp': CLOUD_OPTIONS,
  'shield': SHIELD_OPTIONS,
  'wrap': SHIELD_OPTIONS,
  'mcp-shield': SHIELD_OPTIONS,
  'secrets-mcp': ['--agent'],
  'report': ['--since', '--json', '--no-team-line'],
  'stats': ['--days', '--json'],
  'pins': ['--all'],
  'team status': ['--json'],
  'team sync': [],
  'team leave': [],
  'team join': ['--api', '--agent', '--include-history'],
  'vault log': ['--since'],
  'vault log export': ['--otlp', '--since', '--out', '--unverified'],
  'secret set': SECRET_SET_OPTIONS,
  'secret list': [],
  'secret ls': [],
  'secret rm': [],
  'secret allow': ['--host', '--in', '--replace', '--mode', '--command'],
  'secret approve': ['--command'],
  'secret import': ['--all', '--keys', '--host', '--command', '--force', '--mode', '--in', '--type'],
  'secret adopt': ['--name', '--host', '--command', '--mode', '--in', '--type'],
  'secret log': ['--since'],
  'env shadow': ['--all', '--keys', '--host', '--command', '--force', '--dry-run', '--mode', '--in', '--type'],
  'env unshadow': ['--backup'],
};

// The SIMPLE_OPTIONS entry for these arguments, or null. Secret, env and vault log usage errors exit 64
// (docs/exit-codes.md); the other commands exit 2 (docs/cli.md).
function simpleOptionSpec(args) {
  const [first, second, third] = args;
  if (!['team', 'secret', 'secrets', 'env', 'vault', 'pins'].includes(first) && !SIMPLE_OPTIONS[first]) return null;
  let key = first === 'secrets' ? 'secret' : first;
  if (key !== first || ['team', 'secret', 'env', 'vault'].includes(first)) {
    if (!second) return null;
    key = key + ' ' + second;
    if (first === 'vault' && second === 'log' && third === 'export') key = 'vault log export';
  }
  if (!Object.prototype.hasOwnProperty.call(SIMPLE_OPTIONS, key)) return null;
  const code = /^(secret|env|vault log)( |$)/.test(key) ? 64 : 2;
  return { label: key, options: SIMPLE_OPTIONS[key], code };
}

// The problem with an option that the command does not take, as { message, code }, or null.
// Stops at a bare "--": everything after it is positional text.
function simpleOptionProblem(args) {
  const spec = simpleOptionSpec(args);
  if (!spec) return null;
  const allowed = ['-h', '--help', '-V', '--version'].concat(spec.options);
  for (let i = 1; i < args.length; i++) {
    const tok = args[i];
    if (tok === '--') break;
    if (!tok.startsWith('--')) continue;
    const name = tok.split('=')[0];
    if (allowed.includes(name)) continue;
    const shown = tok.replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
    const list = spec.options.length
      ? 'The options of zn-gate ' + spec.label + ' are ' + spec.options.join(', ') + '.'
      : 'zn-gate ' + spec.label + ' takes no options.';
    return { message: 'unknown option "' + shown + '". ' + list, code: spec.code };
  }
  return null;
}

module.exports = { COMMAND_OPTIONS, expandEqualsOptions, optionProblem, scanTargetOf, simpleOptionProblem };
