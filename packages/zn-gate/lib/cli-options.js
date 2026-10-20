'use strict';

/*
 * Option checking shared by the zn-gate commands that read their options by hand.
 * An option a command does not know is a usage error (exit 2) with a suggestion, never
 * silently ignored: `zn-gate scan --jsn` must not run as if nothing were wrong.
 */

function distance(a, b) {
  const prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

/** The known option closest to `opt` (name only, without any =value), or null when none is close. */
function suggest(opt, known) {
  const name = String(opt).split('=')[0].toLowerCase();
  let best = null;
  let bestD = Infinity;
  for (const k of known) {
    if (!k.startsWith('--')) continue;
    let d = distance(name, k);
    // A cut-off word (--inc) is a closer miss than its edit distance says.
    if (name.length >= 4 && k.startsWith(name)) d = Math.min(d, 1);
    if (d < bestD) { best = k; bestD = d; }
  }
  const limit = Math.max(2, Math.floor(name.length / 3));
  return best !== null && bestD <= limit ? best : null;
}

/** "unknown option --jsn; did you mean --json?" (the suggestion only when one is close). */
function unknownOption(opt, known) {
  const shown = String(opt).replace(/[^\x20-\x7e]/g, '?').slice(0, 60);
  const s = suggest(opt, known);
  return 'unknown option ' + shown + (s ? '; did you mean ' + s + '?' : '');
}

// The options each command knows (the program-wide ones, such as --verbose, are always accepted).
// The help of these commands (cli-help.js) lists exactly these options.
const EVIDENCE_OPTIONS = { flags: ['--verify', '--ui', '--export'], values: ['--format', '--output', '--port', '--tail'] };
const OPTION_SPECS = {
  scan: { flags: ['--code', '--all', '--include-home', '--json'], values: ['--format', '--include', '--exclude'] },
  check: {},
  doctor: {},
  status: {},
  init: { flags: ['--wrap-mcp', '--dry-run', '--shadow', '--revert'] },
  evidence: EVIDENCE_OPTIONS,
  logs: EVIDENCE_OPTIONS,
  export: EVIDENCE_OPTIONS,
};

const GLOBAL_FLAGS = ['--verbose', '--local-only'];
const GLOBAL_VALUES = ['--key', '--stage', '--url', '--long-input'];

/**
 * Checks the options of one command. `args` are the arguments after the command name.
 * spec = { flags: [...], values: [...] }; the global options of the program are always accepted.
 * Returns { error } for the first problem, or { args, positionals } where `--name=value` is split
 * into two arguments and everything after a bare `--` is a positional.
 */
function check(args, spec) {
  const flags = new Set([...(spec.flags || []), ...GLOBAL_FLAGS]);
  const values = new Set([...(spec.values || []), ...GLOBAL_VALUES]);
  const known = [...flags, ...values];
  const out = [];
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') { positionals.push(...args.slice(i + 1).map(String)); break; }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (values.has(name)) {
        if (eq > 0) { out.push(name, a.slice(eq + 1)); continue; }
        const v = args[i + 1];
        if (v === undefined || (String(v).startsWith('--') && v !== '--')) return { error: name + ' needs a value' };
        out.push(name, String(v));
        i++;
        continue;
      }
      if (flags.has(name)) {
        if (eq > 0) return { error: name + ' does not take a value' };
        out.push(a);
        continue;
      }
      return { error: unknownOption(name, known) };
    }
    out.push(a);
    positionals.push(a);
  }
  return { args: out, positionals };
}

module.exports = { suggest, unknownOption, check, OPTION_SPECS };
