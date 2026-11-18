'use strict';
/**
 * Help text of the commands, printed by `zn-gate <command> --help` (and -h).
 * Each entry is the list of lines for one command: the usage line, one sentence of purpose,
 * the options with one line each, and one example. The options match what the command parses.
 */

const HELP = {
  init: [
    'usage: zn-gate init [--wrap-mcp [--dry-run] [--shadow] [--revert]]',
    'Sets up zn for the coding agents on this machine, one step at a time, and then checks it.',
    '  --wrap-mcp   find the MCP servers in known agent configs and wrap them with shield (backups first)',
    '  --dry-run    show what would change and change nothing (selects --wrap-mcp)',
    '  --shadow     wrap in shadow mode: problems are logged, nothing is dropped (selects --wrap-mcp)',
    '  --revert     put back the MCP configs saved before zn wrapped them (selects --wrap-mcp)',
    'Example: zn-gate init --wrap-mcp --dry-run',
  ],
  check: [
    'usage: zn-gate check [--hooks | --json]',
    'Shows that zn blocks your agent from reading a fake secret, in a temporary folder. Nothing is sent over the network. Alias: doctor.',
    '  --hooks   list every installed zn hook and say if it is OK, stale or broken (reads files only)',
    '  --json    print the same check as one JSON object, for scripts and CI',
    'Example: zn-gate check --hooks',
  ],
  status: [
    'usage: zn-gate status [--key API_KEY] [--stage v30|prod] [--url URL] [--local-only] [--verbose]',
    'Shows the version, the rules version, whether the optional cloud check is on and where its key comes from.',
    '  --key API_KEY    API key of the optional cloud check (or set ZN_API_KEY)',
    '  --stage STAGE    cloud gateway stage: v30 (default) or prod',
    '  --url URL        use another gateway address',
    '  --local-only     never use the cloud, even if ZN_CLOUD=1 is set',
    '  --verbose        print debug information to stderr',
    'Example: zn-gate status',
  ],
  test: [
    'usage: zn-gate test',
    'Runs the local self-test on built-in examples (attacks and ordinary developer text). It never uses the network and takes no options.',
    'Example: zn-gate test',
  ],
  version: [
    'usage: zn-gate version',
    'Prints the version of zn-gate and of its rules. It takes no options. -v, -V and --version do the same.',
    'Example: zn-gate version',
  ],
  connect: [
    'usage: zn-gate connect [--reconnect]',
    'Turns on the optional cloud check: you paste an analysis-only API key at a hidden prompt. Your own terminal only.',
    '  --reconnect   replace the key that is already saved',
    'Example: zn-gate connect --reconnect',
  ],
  disconnect: [
    'usage: zn-gate disconnect [--revoke | --no-revoke]',
    'Turns the cloud check off and removes the saved key from this computer. Your own terminal only.',
    '  --revoke      also revoke the key on usezn.com, without asking',
    '  --no-revoke   only remove the local copy',
    'Example: zn-gate disconnect --no-revoke',
  ],
  scan: [
    'usage: zn-gate scan [path] [--format text|json|github] [--all] [--include EXTS] [--exclude DIRS] [--include-home] [--allow-partial]',
    '       zn-gate scan --package NAME[@VERSION]',
    'Looks through prompt templates, markdown, skills and configs for injection traps and secrets. Matched values are never printed.',
    '  --format FORMAT   text (default), json or github (workflow annotations for CI)',
    '  --all, --code     include source code files',
    '  --include EXTS    more file extensions to scan, for example .rst,.xml',
    '  --exclude DIRS    more folders to skip, for example fixtures,legacy',
    '  --include-home    also check your own MCP configs for passwords and keys written in plain text',
    '  --allow-partial   exit 0 even when some files or folders were not read (they are still listed)',
    '  --package SPEC    audit an npm package before you add it; it is downloaded and read, never installed or run',
    'Example: zn-gate scan ./docs --format json',
  ],
  analyze: [
    'usage: zn-gate analyze "<text>" [--json] [--key API_KEY] [--stage v30|prod] [--url URL] [--long-input windows|off] [--local-only] [--verbose]',
    'Checks a piece of text for prompt injection and prints the answer as JSON. Local; the cloud check is used only when it is on.',
    '  --json           accepted; the answer is always JSON',
    '  --key API_KEY    API key of the optional cloud check (or set ZN_API_KEY)',
    '  --stage STAGE    cloud gateway stage: v30 (default) or prod',
    '  --url URL        use another gateway address',
    '  --long-input M   long texts sent to the cloud: windows (default) or off (first 512 tokens only)',
    '  --local-only     never use the cloud',
    '  --verbose        print debug information to stderr',
    'Exit codes: 0 allowed, 1 no text given, 2 blocked.',
    'Example: zn-gate analyze "ignore all previous instructions"',
  ],
  pins: [
    'usage: zn-gate pins [approve <server> | approve --all]',
    'Lists the MCP servers that shield has pinned and the tools that changed since. "pins approve" accepts the changes.',
    '  approve SERVER   accept the changed or new tools of one server (your own terminal only)',
    '  approve --all    accept them for every server',
    'Example: zn-gate pins',
  ],
  'pins approve': [
    'usage: zn-gate pins approve <server> | --all',
    'Accepts the changed or new tools of one MCP server, or of every server with --all. It asks you to type the server key again and needs your own terminal.',
    '  --all   approve every server',
    'Example: zn-gate pins approve --all',
  ],
  secret: [
    'usage: zn-gate secret <set|list|allow|approve|rm|import|adopt|log> ...',
    'Stores and manages secrets in the local vault. Values never leave this machine; agents only see __ZN_<NAME>__ markers. Alias: secrets.',
    '  set NAME       store a secret (hidden prompt or --clipboard; never as an argument)',
    '  list           list stored secrets (names and policy, never values)',
    '  allow NAME     add allowed hosts (--host) or commands (--command) to a secret',
    '  approve NAME   approve the first use of a secret by an allowed command',
    '  rm NAME        remove a secret',
    '  import FILE    copy the secret values of a .env file into the vault',
    '  adopt TOKEN    store a value the scrubber detected as a named secret',
    '  log            show the audit log of secret use [--since 1h]',
    'Example: zn-gate secret list',
  ],
  env: [
    'usage: zn-gate env <shadow|unshadow> ...',
    'Moves the values of a .env file into the vault and back.',
    '  shadow [FILE]                    move the values into the vault and leave markers in the file',
    '  unshadow FILE --backup NAME      put the original values back from the encrypted copy that shadow printed',
    'Run zn-gate env shadow --help for the options of shadow.',
    'Example: zn-gate env shadow .env --dry-run',
  ],
  run: [
    'usage: zn-gate run [--secrets NAME[,NAME...]] [--agent ID] [--egress-allow HOST[:PORT],...] -- <command> [args...]',
    'Runs a command with secrets in its environment (allowed commands only) and masks the values in its output. Everything after -- belongs to your command.',
    '  --secrets, -s NAMES      secrets to set as environment variables',
    '  --agent ID               name the agent in the audit log (or set ZN_AGENT)',
    '  --egress-allow HOSTS     let the command reach only those hosts over HTTP(S), through a local proxy',
    'Example: zn-gate run --secrets API_KEY -- curl https://api.example.com/',
  ],
  hooks: [
    'usage: zn-gate hooks <install|uninstall> <agent> [--project] [--no-mcp]',
    'Adds or removes the zn hooks of a coding agent. Needs your own terminal.',
    '  install AGENT     add the hooks, and the secrets MCP server unless --no-mcp is given',
    '  uninstall AGENT   remove them again',
    '  --project         change the settings of the current project instead of your user settings',
    '  --no-mcp          leave the secrets MCP server out',
    'Agents: claude-code, codex, cursor, opencode, antigravity, zcode, gemini, copilot.',
    'Example: zn-gate hooks install claude-code --project',
  ],
  hook: [
    'usage: zn-gate hook <agent>',
    'The entry point the agents call. It reads one event as JSON on standard input and answers on standard output. You do not run it yourself.',
    'Exit codes: 0 allowed, 2 blocked (or an event it cannot read), 1 unknown agent.',
    'Example: zn-gate hook claude-code < event.json',
  ],
  'secrets-mcp': [
    'usage: zn-gate secrets-mcp [--agent ID]',
    'Runs the "secrets" MCP server over standard input and output. Agents start it from their config; it never returns a secret value.',
    '  --agent ID   name the agent in the audit log',
    'Example: zn-gate secrets-mcp --agent claude-code',
  ],
  mcp: [
    'usage: zn-gate mcp',
    'Runs zn-gate as an MCP server over standard input and output, with the tools analyze_prompt, check_tool_call, check_tool_result and zn_status. It takes no options and runs until its input is closed.',
    'Example: zn-gate mcp',
  ],
  shield: [
    'usage: zn-gate shield [--shadow] -- <command> [args...]',
    'Wraps any external MCP server and checks its traffic. Aliases: mcp-shield, wrap.',
    '  --shadow   watch and record but block nothing (put it before the --)',
    'Example: zn-gate shield -- uvx mcp-server-fetch',
  ],
  evidence: [
    'usage: zn-gate evidence [--verify] [--ui [--port 3100]] [--export [--format jsonl|csv] [--output FILE]] [--tail N]',
    'Shows the local hash-chained log of what zn-gate decided. With no option it prints the counts and the last records. Aliases: logs, export (export is the same as evidence --export).',
    '  --verify          check the SHA-256 chain; exit 1 if it was changed',
    '  --ui              open a local dashboard in your browser',
    '  --port PORT       port of the dashboard (default 3100)',
    '  --export          write the records to the screen or to --output',
    '  --format FORMAT   jsonl (default) or csv',
    '  --output FILE     write the export to a file',
    '  --tail N          number of last records to show (default 20)',
    'Example: zn-gate evidence --tail 5',
  ],
  why: [
    'usage: zn-gate why [<id>]',
    'Explains, in plain words, the last block in the local decision log, or the record with that id (the id field of zn-gate evidence --export). It only reads the log.',
    'Exit codes: 0 explained, 1 nothing to explain, 2 wrong usage.',
    'Example: zn-gate why',
  ],
  stats: [
    'usage: zn-gate stats [--days N] [--json]',
    '       zn-gate stats share [on|off|status|show]',
    'Shows what zn-gate did on this machine: local counts for the last days.',
    '  --days N   days to count, 1 to 90 (default 30)',
    '  --json     print one JSON object',
    '  share      optional sharing of pseudonymous daily counts (off by default); run zn-gate stats share --help',
    'Example: zn-gate stats --days 7',
  ],
  'stats share': [
    'usage: zn-gate stats share [on|off|status|show]',
    'Controls the optional sharing of pseudonymous daily counts. It is off by default and only you can turn it on, in your own terminal.',
    '  on       explain what would be shared and ask you to confirm',
    '  off      turn sharing off',
    '  status   say whether sharing is on (the default)',
    '  show     show exactly what would be sent, and where',
    'Example: zn-gate stats share show',
  ],
  report: [
    'usage: zn-gate report [--since Nd] [--json] [--no-team-line]',
    'Prints a short report of what zn-gate did on this machine in the last days. Built from local files; nothing is sent.',
    '  --since Nd        period, 1d to 90d (default 7d)',
    '  --json            print one JSON object',
    '  --no-team-line    leave out the line about zn Team',
    'Example: zn-gate report --since 30d',
  ],
};

// Other names of the same command.
const ALIASES = {
  doctor: 'check', '-v': 'version', secrets: 'secret', 'mcp-shield': 'shield', wrap: 'shield',
  logs: 'evidence', export: 'evidence',
};
// `stats share on|off|status|show` share one page.
const SHARE_WORDS = new Set(['on', 'off', 'status', 'show']);

// Commands whose arguments after the command name are words or a program to run: only an exact
// `<command> --help` asks for help, so a --help meant for the wrapped program is left alone.
const EXACT_ONLY = new Set(['analyze', 'secret', 'secrets', 'env', 'hooks', 'hook', 'run', 'shield', 'mcp-shield', 'wrap']);

function isHelpFlag(a) { return a === '-h' || a === '--help'; }
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The help lines for `zn-gate <command> --help` (or -h), or null when the arguments do not ask
 * for the help of one of these commands.
 */
function helpFor(args) {
  const cmd = args[0];
  if (typeof cmd !== 'string' || !(has(ALIASES, cmd) || has(HELP, cmd))) return null;
  const key = has(ALIASES, cmd) ? ALIASES[cmd] : cmd;
  const stop = args.indexOf('--');
  const head = stop === -1 ? args : args.slice(0, stop);
  const rest = head.slice(1);
  if (!rest.some(isHelpFlag)) return null;
  if (key === 'pins' && rest[0] === 'approve') return HELP['pins approve'];
  if (key === 'stats' && rest[0] === 'share' && (rest.length === 2 || (rest.length === 3 && SHARE_WORDS.has(rest[1])))) return HELP['stats share'];
  if (EXACT_ONLY.has(cmd) && !(rest.length === 1 && isHelpFlag(rest[0]))) return null;
  return HELP[key];
}

module.exports = { helpFor, HELP, ALIASES };
