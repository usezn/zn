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
    // --json is a no-op: analyze always prints JSON. The Python package accepts the flag too.
    flag: [...CLOUD_FLAG_OPTIONS, '--json'],
    listed: CLOUD_VALUE_OPTIONS.concat(CLOUD_FLAG_OPTIONS, ['--json']),
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

module.exports = { COMMAND_OPTIONS, expandEqualsOptions, optionProblem, scanTargetOf };
