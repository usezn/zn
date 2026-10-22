'use strict';
/**
 * Checks the arguments of scan, check (doctor), status and evidence (logs, export).
 * An option the command does not know, an option without its value and a stray word
 * are a usage error (exit 2), never silently ignored.
 *
 * The options every command accepts (see "Settings" in docs/cli.md) are listed in GLOBAL;
 * true means the option needs a value after it.
 */

const GLOBAL = { '--verbose': false, '--local-only': false, '--key': true, '--stage': true, '--url': true, '--long-input': true };

const SPECS = {
  scan: {
    options: { '--format': true, '--all': false, '--code': false, '--include': true, '--exclude': true, '--include-home': false },
    maxWords: 1,
    usage: 'usage: zn-gate scan [path] [--format text|json|github] [--all] [--include .rst,.xml] [--exclude fixtures,legacy] [--include-home]',
  },
  check: {
    options: {},
    maxWords: 0,
    usage: 'usage: zn-gate check',
  },
  status: {
    options: {},
    maxWords: 0,
    usage: 'usage: zn-gate status',
  },
  evidence: {
    options: { '--verify': false, '--ui': false, '--export': false, '--format': true, '--output': true, '--port': true, '--tail': true },
    maxWords: 0,
    usage: 'usage: zn-gate evidence [--verify] [--ui [--port 3100]] [--export [--format jsonl|csv] [--output file]] [--tail 20]',
  },
};
SPECS.doctor = SPECS.check;
SPECS.logs = SPECS.evidence;
SPECS.export = SPECS.evidence;

const EXPORT_FORMATS = ['jsonl', 'csv'];

function shown(s) {
  return String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
}

/**
 * The first problem in `rest` (the arguments after the command name), or null.
 * Returns { problem, usage } for a problem, or { words } (the arguments that are not options) when it is fine.
 * A command that is not checked here returns { words: [] }.
 */
function validate(command, rest) {
  const spec = SPECS[command];
  if (!spec) return { words: [] };
  const known = { ...GLOBAL, ...spec.options };
  const words = [];
  for (let i = 0; i < rest.length; i++) {
    const a = String(rest[i]);
    if (a === '--') { words.push(...rest.slice(i + 1)); break; }
    if (a.startsWith('-') && a !== '-') {
      const name = a.indexOf('=') > 0 && a.startsWith('--') ? a.slice(0, a.indexOf('=')) : a;
      if (!Object.prototype.hasOwnProperty.call(known, name)) return { problem: 'Unknown option "' + shown(a) + '".', usage: spec.usage };
      if (name !== a) return { problem: 'Write the value after a space, not after "=": ' + name + ' VALUE.', usage: spec.usage };
      if (known[a]) {
        const v = rest[i + 1];
        if (v === undefined || String(v).startsWith('--')) return { problem: 'The option ' + a + ' needs a value.', usage: spec.usage };
        i++;
        if (a === '--format' && (command === 'evidence' || command === 'logs' || command === 'export') && !EXPORT_FORMATS.includes(String(v).toLowerCase())) {
          return { problem: '--format must be jsonl or csv.', usage: spec.usage };
        }
      }
      continue;
    }
    words.push(a);
  }
  if (words.length > spec.maxWords) return { problem: 'Unexpected argument "' + shown(words[spec.maxWords]) + '".', usage: spec.usage };
  return { words };
}

module.exports = { validate, SPECS };
