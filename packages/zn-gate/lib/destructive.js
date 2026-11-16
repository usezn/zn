'use strict';

/**
 * Optional policy for destructive shell commands.
 *
 * Off by default. The agent hooks apply it only when the user turns it on
 * (`{"hooks": {"blockDestructiveCommands": true}}` in ~/.zn/config.json, or
 * ZN_BLOCK_DESTRUCTIVE=1); the SDK function checkCommand() always applies it,
 * because calling it is the opt-in.
 *
 * Narrow on purpose: a command is blocked only when its shape is one of the
 * few below. It is a guardrail against a model's mistake or a bad suggestion,
 * not a sandbox: a command built at run time (`rm -rf "$DIR"` with an empty
 * variable, a script file the agent wrote and then runs) is not seen.
 *
 *   rm_root_home     recursive delete of the home folder, the filesystem root,
 *                    a top-level system folder or a drive root
 *   pipe_to_shell    a download that is run as a script (or by python, node, perl or ruby) without being read
 *   disk_overwrite   dd, mkfs, wipefs ... on a block device, or a redirect to one
 *   perm_root        chmod -R 777 or chown -R on the root or a system folder
 *   fork_bomb        the classic shell fork bomb
 *   rc_download     a download written into a shell startup file
 *
 * A cd or pushd earlier in the same command line is followed: after `cd ~ && find . -delete` the "." is the home folder.
 * A cd made by an earlier tool call, or inside a subshell or a pipeline, is not seen.
 *
 * The command is split with the hook policy's own tokenizer (scanFirstCommand),
 * so quotes and escapes read the same as in the rest of the policy.
 */

const COMMAND_RULES_VERSION = '2026-11-16.19';

const REASONS = {
  rm_root_home: 'it deletes the home folder, the filesystem root or a system folder, recursively',
  pipe_to_shell: 'it downloads a script and runs it without anyone reading it first',
  disk_overwrite: 'it writes to or formats a disk device',
  perm_root: 'it changes permissions or owners across the whole filesystem or a system folder',
  fork_bomb: 'it is a fork bomb, which freezes the machine',
  rc_download: 'it writes downloaded content into a shell startup file, which runs in every new terminal',
};

const MAX_DEPTH = 3;
// Same limit as the policy's own tokenizer: enough simple commands for any text under the shell scan cap.
const MAX_SEGMENTS = 50000;
const OVERFLOW = 'too_many_commands';
const OVERFLOW_REASON = 'it has more commands than can be checked, so it is refused rather than guessed at';
const MAX_CHARS = 200 * 1024;
const QUOTE_SCAN_MAX = 20000;

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const shellVars = require('./shell-vars');
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'rbash']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
const DOWNLOADERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'aria2c', 'fetch']);
const RM_HEADS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir']);
const CMD_HEADS = new Set(['rd', 'rmdir', 'del', 'erase']);
const DISK_TOOLS = /^(?:mkfs(?:\.[a-z0-9]+)?|mke2fs|mkswap|wipefs|shred|blkdiscard)$/;
const FIND_TESTS = /^-(?:i?name|i?path|i?wholename|i?regex|type|[acm]time|[acm]min|newer\w*|size|user|group|perm|empty|links|inum|samefile|executable|readable|writable|uid|gid)$/;
// Words that start a command without being one: a group, the branches of if / while / until / for, and negation.
const SHELL_KEYWORDS = new Set(['{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!']);
// Words of cmd.exe (call rd ...) and PowerShell (try { ... }) that only run the command after them.
const RUN_NEXT_WORDS = new Set(['call', 'try']);
const SUDO_ARG_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-U', '-D', '-R', '--user', '--group', '--host', '--prompt',
  '--close-from', '--other-user', '--role', '--type', '--command-timeout', '--chroot']);
// More words than this that could each be the command behind an unsure wrapper chain: the line is refused, not guessed at.
const LATER_HEADS_MAX = 64;

const SYSTEM_DIRS = new Set(['/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/root',
  '/sbin', '/srv', '/sys', '/usr', '/var', '/Users', '/System', '/Library', '/Applications', '/private', '/Volumes']);
const HOME_WORDS = new Set(['~', '$home', '${home}', '$userprofile', '${userprofile}', '%userprofile%', '$env:userprofile', '$env:home', '$env:homepath']);
const BLOCK_DEVICE_RE = /^\/dev\/(?:sd[a-z]+\d*|hd[a-z]+\d*|vd[a-z]+\d*|xvd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|disk\d+(?:s\d+)?|rdisk\d+(?:s\d+)?|md\d+|dm-\d+|mapper\/[A-Za-z0-9._-]+)$/;
const RC_UNIX_RE = /\/\.(?:bashrc|bash_profile|bash_login|bash_aliases|profile|zshrc|zprofile|zshenv|zlogin|kshrc|cshrc|tcshrc)$|\/fish\/config\.fish$|^\/etc\/(?:profile|bash\.bashrc|zshrc|zsh\/zshrc|environment)$|^\/etc\/profile\.d\//;
const RC_PS_RE = /^\$profile(?:\.\w+)?$|(?:^|[\\/])(?:microsoft\.powershell_)?profile\.ps1$/i;

const QUOTED_RE = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const FORK_BOMB_RE = /(?<![\w:])([A-Za-z_:][\w:]*)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1(?!\w)/;
// Unquoted command substitutions and process substitutions are not split into words by the tokenizer.
// The downloader inside the substitution may be written \curl, env curl, command -p curl or /usr/bin/curl, and the shell
// /bin/sh or env sh. Every quantifier below is over a class that cannot also match the separator after it, so the scan is linear.
// Up to three wrappers (sudo, doas, env, command, exec, nohup) with their option words may come before the downloader.
const SUBST_DL_SRC = String.raw`(?:(?:sudo|doas|env|command|exec|nohup)\s+(?:(?:-\S*|\w+=\S*)\s+)*){0,3}\\?(?:[\w.~-]*\/)*(?:c\\?u\\?r\\?l|w\\?g\\?e\\?t)\b`;
const SUBST_SHELL_SRC = String.raw`(?:[\w.~-]*\/)*(?:ba|z|da|k)?sh`;
// An interpreter that runs a program given as a file, on stdin or as its code option: python3 <(curl URL),
// python3 -c "$(curl URL)", node -e "$(curl URL)".
const SUBST_INTERP_SRC = String.raw`(?:[\w.~-]*\/)*(?:python(?:[23](?:\.\d+)?)?|py|pypy3?|node(?:js)?|perl|ruby)`;
const SUBST_RUNNER_SRC = '(?:' + SUBST_SHELL_SRC + '|' + SUBST_INTERP_SRC + ')';
const SHELL_RUNS_DOWNLOAD_RE = new RegExp(String.raw`(?:^|[\s;&|(])(?:eval|` + SUBST_SHELL_SRC + String.raw`\s+(?:-\w+\s+)*-\w*c` +
  '|' + SUBST_INTERP_SRC + String.raw`\s+(?:-\w+\s+)*?(?:-\w*[ceE]|-p|--eval|--print))` +
  String.raw`\s+["']?(?:\$\(|` + '`' + String.raw`)\s*` + SUBST_DL_SRC);
const SOURCE_DOWNLOAD_RE = new RegExp(String.raw`(?:^|[\s;&|(])(?:source|\.|` + SUBST_RUNNER_SRC + String.raw`)\s+(?:-\w+\s+)*<\(\s*` + SUBST_DL_SRC);
// A shell or interpreter that reads its program from a substitution on stdin: bash < <(curl URL), sh <<< "$(curl URL)".
const SHELL_STDIN_DOWNLOAD_RE = new RegExp(String.raw`(?:^|[\s;&|(])` + SUBST_RUNNER_SRC + String.raw`\s+(?:-\S*\s+)*(?:<\s*<\(|<<<\s*["']?(?:\$\(|` + '`' + String.raw`))\s*` + SUBST_DL_SRC);
// The executor may be called with the call or dot-source operator, and named in quotes: | & iex, | . 'iex', & "irm" URL.
const PS_EXEC_SRC = String.raw`(?:[&.]\s*)?['"]?(?:iex|invoke-expression)\b`;
const PS_PIPE_RE = new RegExp(String.raw`\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\b[^|;\n]{0,300}\|\s*` + PS_EXEC_SRC +
  String.raw`|\bdownloadstring\([^)]{0,300}\)\s*\|\s*` + PS_EXEC_SRC, 'i');
// One run of blanks, ( and $ before the downloader, then an optional call operator: no two quantifiers can take the same
// characters, so a long run of parentheses is read once (iex followed by 20000 "(" stays linear).
const PS_CALL_RE = /(?:^|[\s;&|({])(?:iex|invoke-expression)\b[\s($]*(?:[&.]\s*)?['"]?(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|new-object\s+(?:system\.)?net\.webclient)\b/i;
const PS_QUOTED_NAME_RE = /([&.]\s*)(['"])(iex|invoke-expression|iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)\2/gi;
// PowerShell escapes a character with a backtick (i`wr, Invoke-`Expression). Only a backtick inside a word counts: in
// POSIX shells a backtick starts a command substitution, so the text is never stripped for the other patterns.
const PS_NEXT_PIPE_RE = /\r?\n[ \t]*\|/g;
const PS_TICK_RE = /(?:(?<=[\s|;&(A-Za-z0-9_.-])|^)`(?=[A-Za-z-])/g;
const PS_DISK_RE = /(?:^|[\s;&|(])(?:format-volume|clear-disk)\b/i;

// Code an interpreter runs from its command line (python -c, node -e, perl -e, ruby -e) and a download piped into one.
// The option patterns are linear: an option word that may say "no program from stdin" has at most 32 letters on
// each side of its key letter. A longer word is not taken as such an option, so a pipe into it stays blocked.
const INTERPRETER_RE = /^(?:py|python(?:[23](?:\.\d+)?)?|pypy3?|node(?:js)?|perl|ruby)$/;
const INTERPRETERS = {
  py: { skip: new Set(['-W', '-X']), code: /^-[A-Za-z]*c$/, noStdin: /^(?:-[A-Za-z]{0,32}[cmVh][A-Za-z]{0,32}|--(?:version|help))$/ },
  node: { skip: new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']), code: /^(?:-e|-p|-pe|--eval|--print)$/, noStdin: /^(?:-[A-Za-z]{0,32}[epcvh][A-Za-z]{0,32}|--(?:eval|print|check|version|help|test)(?:=.*)?)$/ },
  perl: { skip: new Set(['-I']), code: /^-[A-Za-z]*[eE]$/, noStdin: /^-[A-Za-z]{0,32}[eEcvVh][A-Za-z]{0,32}$/ },
  ruby: { skip: new Set(['-r', '-I']), code: /^-[A-Za-z]*e$/, noStdin: /^(?:-[A-Za-z]{0,32}[ecvh][A-Za-z]{0,32}|--(?:version|help))$/ },
};
// A recursive-delete call: shutil.rmtree, fs.rmSync / rmdirSync / rm / rmdir, rimraf, File::Path remove_tree / rmtree,
// FileUtils.rm_rf / rm_r / remove_entry, and Perl's unlink glob(...).
const OI_CALL_RE = /\b(rmtree|remove_tree|remove_entry_secure|remove_entry|remove_dir|rm_rf|rm_r|rimraf|removeSync|rmSync|rmdirSync|rmdir|rm)\b(?:\s{0,20}\.\s{0,20}sync\b)?\s{0,20}(\()?/g;
const OI_GLOB_RE = /\bunlink\s{0,20}\(?\s{0,20}glob\b\s{0,20}\(?/g;
const OI_NEEDS_PAREN = new Set(['rimraf', 'removeSync', 'rmSync', 'rmdirSync', 'rmdir', 'rm']);
const OI_NEEDS_RECURSIVE = new Set(['rmSync', 'rmdirSync', 'rmdir', 'rm']);
const OI_RECURSIVE_RE = /\brecursive['"]?\s{0,20}:\s{0,20}(?:true|1|!0)/;
const OI_PATH_WRAP_RE = /^(?:(?:pathlib\s{0,20}\.\s{0,20})?(?:Pure)?(?:Posix)?(?:Windows)?Path\s{0,20}\(\s{0,20}|(?:path|dirname|dir)\s{0,20}=\s{0,20})/;
// The home folder named by an expression and not by a literal: expanduser('~'), os.homedir(), Path.home(), Dir.home, $ENV{HOME} ...
const OI_HOME_RE = /^(?:(?:os\s{0,20}\.\s{0,20}path\s{0,20}\.\s{0,20})?expanduser\s{0,20}\(\s{0,20}['"]~\/?['"]\s{0,20}\)|(?:require\s{0,20}\(\s{0,20}['"](?:node:)?os['"]\s{0,20}\)\s{0,20}\.\s{0,20}|os\s{0,20}\.\s{0,20})?homedir\s{0,20}\(\s{0,20}\)|(?:pathlib\s{0,20}\.\s{0,20})?Path\s{0,20}\.\s{0,20}home\s{0,20}\(\s{0,20}\)|Dir\s{0,20}\.\s{0,20}home\b(?:\s{0,20}\(\s{0,20}\))?|File\s{0,20}\.\s{0,20}expand_path\s{0,20}\(\s{0,20}['"]~\/?['"]\s{0,20}\)|ENV\s{0,20}\[\s{0,20}['"]HOME['"]\s{0,20}\]|\$ENV\s{0,20}\{\s{0,20}['"]?HOME['"]?\s{0,20}\}|os\s{0,20}\.\s{0,20}environ\s{0,20}\[\s{0,20}['"]HOME['"]\s{0,20}\]|os\s{0,20}\.\s{0,20}(?:getenv|environ\s{0,20}\.\s{0,20}get)\s{0,20}\(\s{0,20}['"]HOME['"]\s{0,20}\)|process\s{0,20}\.\s{0,20}env\s{0,20}(?:\.\s{0,20}HOME\b|\[\s{0,20}['"]HOME['"]\s{0,20}\]))/;
const OI_LITERAL_RE = /^[rRbBuUfF]{0,2}(['"`])((?:[^'"`\\\r\n]|\\.){0,200})\1/;
const OI_ENV_HOME_RE = /\$ENV\{['"]?HOME['"]?\}|\$\{?HOME\}?|%USERPROFILE%/gi;

// policy.js requires this file back, so it is loaded on first use. The result is kept: calling require() for every word
// repeats the module lookup (file-system checks), which is slow on Windows and was most of the time of a long line there.
let policyCached = null;
function policyModule() {
  if (policyCached === null) policyCached = require('./hooks/policy');
  return policyCached;
}

// The drive of the system and of the home folder, as cmd.exe and PowerShell name them.
const DRIVE_VARS_SRC = String.raw`%(?:systemdrive|homedrive)%|\$env:(?:systemdrive|homedrive)|\$\{env:(?:systemdrive|homedrive)\}`;
const DRIVE_ROOT_WIN_RE = new RegExp(String.raw`(^|[\s"'=:\\])([A-Za-z]:|` + DRIVE_VARS_SRC + String.raw`)\\(?=[\s"');&|}]|$)`, 'gi');
const DRIVE_VAR_RE = new RegExp('^(?:' + DRIVE_VARS_SRC + ')(?=/|$)', 'i');
const WINDIR_VAR_RE = /^(?:%(?:windir|systemroot)%|\$env:(?:windir|systemroot)|\$\{env:(?:windir|systemroot)\})(?=\/|$)/i;
const COMSPEC_WORDS = new Set(['%comspec%', '$env:comspec', '${env:comspec}']);

function programName(text) {
  // cmd.exe runs @rd like rd (the @ only hides the echo); PowerShell reads Rem`ove-Item as Remove-Item.
  let name = String(text).replace(/^[\\@]+/, '');
  if (name.includes('`')) name = name.replace(/`(?=[A-Za-z-])/g, '');
  if (COMSPEC_WORDS.has(name.toLowerCase())) return 'cmd';
  return name.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

/* Simple commands of a command line, with the operator that follows each: [{ words: string[], sep }]. */
function segmentsOf(cmd, posix = false) {
  const { scanFirstCommand } = policyModule();
  // 2>&1 and &> are redirections, not the control operator &.
  // A drive root C:\ before a space is a path, not an escaped space.
  // Only the & changes, so the pattern starts at the last < or > before it: a long run of > stays linear.
  let rest = String(cmd).replace(/([<>])&(\d+|-)/g, '$1_$2').replace(/&>>?/g, '>');
  // The Windows reading: cmd.exe and PowerShell have no backslash escapes, so C:\ (or %SystemDrive%\, the long path
  // form \\?\C:\, -Path:C:\, D=C:\) also ends before a quote, a ) ; & | or }. The POSIX reading keeps the shell's own
  // escapes, so text that only bash would read differently is still checked there.
  rest = posix ? rest.replace(/(^|[\s"'])([A-Za-z]:)\\(?=\s|$)/g, '$1$2/') : rest.replace(DRIVE_ROOT_WIN_RE, '$1$2/');
  const out = [];
  let guard = 0;
  for (; rest.length && guard < MAX_SEGMENTS; guard++) {
    const scan = scanFirstCommand(rest, posix);
    let sep = scan.operator;
    let adv = scan.end + 1;
    // An unquoted word that starts with # opens a comment: it and the rest of the line are not part of the command.
    const cAt = scan.words.findIndex((w) => rest[w.start] === '#');
    if (cAt >= 0) {
      const nlAt = rest.indexOf('\n', scan.words[cAt].start);
      scan.words.length = cAt;
      scan.end = nlAt < 0 ? rest.length : nlAt;
      sep = nlAt < 0 ? null : '\n';
      adv = scan.end + 1;
    }
    if (sep === '|' || sep === '&') {
      const next = rest[scan.end + 1];
      if (next === sep) { sep += sep; adv++; } else if (sep === '|' && next === '&') { sep = '|&'; adv++; }
    }
    // The text of the command, kept only when it holds a backtick: its substitution starts from the folder reached by then.
    const raw = rest.slice(0, scan.end);
    const entry = { words: scan.words.map((w) => w.text), sep, raw: raw.includes('`') ? raw : '', opens: 0 };
    out.push(entry);
    rest = rest.slice(adv);
    // A pipe continues over a line break, and its target may be a group: curl URL |<nl>sh, curl URL | (sh).
    // Each ( dropped here is still a group the line closes later: opens counts them so checkSegments pairs the ) with it.
    if (sep === '|' || sep === '|&') {
      const lead = /^(?:\s|\()+/.exec(rest);
      if (lead) {
        entry.opens = lead[0].split('(').length - 1;
        rest = rest.slice(lead[0].length);
      }
    }
  }
  // Unread text left over: the caller must not treat the commands read so far as the whole line.
  out.truncated = rest.length > 0;
  return out;
}

const isPipe = (sep) => sep === '|' || sep === '|&';

const CD_HEADS = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
const ANCHORED_RE = /^(?:[\\/~$%]|[A-Za-z]:)/;
const NOT_CD = Symbol('not-cd');
// A folder path longer than this (after "." and ".." are resolved) is not followed: the line is refused instead.
const MAX_CWD_CHARS = 4096;
const CWD_OVERFLOW = Symbol('cwd-overflow');
// A folder that stepped above the home folder or a drive root is unknown, and treated as protected for the rest of the line.
const CWD_LOST = Symbol('cwd-lost');

/* The folder a line has reached is kept as an immutable chain: an anchor (the root, a drive, a home word) and the
   segments below it, newest first. A cd adds or drops one segment, so the cost of a step does not depend on how long
   the folder is. kind is 'root', 'drive', 'home' or 'other' (a variable or ~user the line cannot see through). */
function folderRoot(kind, a) { return { kind, a, up: null, seg: '', n: 0, len: a.length }; }

/* One step from folder `f` (a chain, CWD_LOST or null): a segment name, "." or "..". Returns the new folder, CWD_LOST,
   null (unknown) or CWD_OVERFLOW. */
function folderStep(f, seg) {
  if (f === null || f === CWD_LOST || f === CWD_OVERFLOW) return f;
  if (seg === '' || seg === '.') return f;
  if (seg === '..') {
    if (f.n > 0) return f.up;
    if (f.kind === 'home') return CWD_LOST;
    return f.kind === 'other' ? null : f;
  }
  const len = f.len + seg.length + 1;
  if (len > MAX_CWD_CHARS) return CWD_OVERFLOW;
  return { kind: f.kind, a: f.a, up: f, seg, n: f.n + 1, len };
}

function folderWalk(f, path) {
  for (const seg of path.split('/')) {
    f = folderStep(f, seg);
    if (f === null || f === CWD_LOST || f === CWD_OVERFLOW) return f;
  }
  return f;
}

/* The folder an anchored word names (absolute, drive, home or variable). */
function folderOf(word) {
  const t = String(word).replace(/\s+$/, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const drive = /^[A-Za-z]:(?:\/|$)/.exec(t);
  if (t.startsWith('/')) return folderWalk(folderRoot('root', '/'), t.slice(1));
  if (drive) return folderWalk(folderRoot('drive', t.slice(0, 2) + '/'), t.slice(drive[0].length));
  const first = t.split('/')[0];
  return folderWalk(folderRoot(HOME_WORDS.has(first.toLowerCase()) ? 'home' : 'other', first + '/'), t.slice(first.length + 1));
}

/* The text of the last `m` segments of folder `f`, as a path; when segments are left out it starts at a made-up anchor. */
function folderText(f, m) {
  const segs = [];
  let g = f;
  for (let i = 0; i < m && g.n > 0; i++, g = g.up) segs.push(g.seg);
  segs.reverse();
  const base = g.n > 0 ? '/__' : g.kind === 'root' ? '' : g.a.replace(/\/$/, '');
  return base + (segs.length ? '/' + segs.join('/') : '');
}

/* The working folder a cd or pushd leaves behind: a folder chain, CWD_LOST, or null when it cannot be known (cd -, a
   relative folder from an unknown place, popd). `cwd` is the folder before the command (null = unknown). Returns NOT_CD
   when the words are not a directory change. */
function cdTarget(args, cwd) {
  if (!args.length) return NOT_CD;
  const head = programName(args[0]);
  if (head === 'popd' || head === 'pop-location') return null;
  if (!CD_HEADS.has(head)) return NOT_CD;
  // cmd.exe's /d (change the drive too) is an option, not the folder.
  let ops = args.slice(1).filter((w) => (!/^-[A-Za-z]+$/.test(w) || w === '-') && !((head === 'cd' || head === 'chdir') && /^\/d$/i.test(w)));
  if (ops[0] === '--') ops = ops.slice(1);
  // A bare cd goes home; a bare pushd swaps directories, which is not known here.
  if (!ops.length) return head === 'pushd' || head === 'push-location' ? null : folderOf('~');
  const t = ops[0];
  if (t === '-') return null;
  // Anchored words (absolute, drive, home or variable) name the folder on their own; a relative word follows the old folder.
  if (ANCHORED_RE.test(t)) return folderOf(t);
  return folderRel(cwd, t);
}

/* A relative folder word followed from the folder `cwd` (null = unknown). */
function folderRel(cwd, w) {
  if (cwd === null || cwd === undefined) return null;
  return folderWalk(cwd, String(w).replace(/\s+$/, '').replace(/\\/g, '/'));
}

/* A word read from the folder `cwd`: relative words are joined to it, anchored words are kept. Only as many trailing
   segments of the folder as the word's ".." can reach (plus four) are written out: a protected folder is at most three
   segments deep, so the rest cannot change the answer. */
function fromCwd(cwd, word) {
  const w = String(word);
  if (!cwd || !w || ANCHORED_RE.test(w)) return w;
  if (cwd === CWD_LOST) return '/';
  const ups = w.split(/[\\/]/).filter((s) => s === '..').length;
  return folderText(cwd, ups + 4) + '/' + w;
}

/* The text of every unquoted or double-quoted `...` command substitution of a command, joined into one text to be read
   as commands, or '' when there is none. An escaped backtick inside one is a nested substitution. One pass over the text. */
function backtickCode(text) {
  const bodies = [];
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = ''; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '"') { quote = quote === '"' ? '' : '"'; continue; }
    if (ch === "'" && quote === '') { quote = "'"; continue; }
    if (ch !== '`') continue;
    let body = '';
    let j = i + 1;
    for (; j < text.length && text[j] !== '`'; j++) {
      if (text[j] === '\\' && j + 1 < text.length && (text[j + 1] === '`' || text[j + 1] === '\\')) j++;
      body += text[j];
    }
    bodies.push(body);
    i = j;
  }
  return bodies.join('\n');
}

/* The folder a command runs in when it is wrapped in env -C / sudo -D: `dirs` are the words of its chdir options in
   order, each read from the folder before it (an anchored word wins, a relative one follows the earlier one); `known`
   is the folder before the command (null = unknown). */
function inDir(known, dirs) {
  for (const d of dirs) {
    if (known === CWD_OVERFLOW) return known;
    known = ANCHORED_RE.test(d) ? folderOf(d) : folderRel(known, d);
  }
  return known;
}

function addDir(dirs, w) { if (w) dirs.push(w); }

// Programs that only run another command: more than 32 of them in a row is refused, not read.
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'builtin', 'setsid', 'nice', 'ionice', 'timeout']);

/* One env option word f (args[i - 1]); returns the index of the next word. Options are read like GNU env (getopt_long "+C:iS:u:v0a:"):
   a short cluster is walked letter by letter, and C, S, u or a take the rest of the cluster or the next word as their value; a long
   option may be an unambiguous prefix (--split-s, --chd). The -S string is kept for a second reading. */
const ENV_LONG = ['ignore-environment', 'null', 'unset', 'chdir', 'split-string', 'argv0', 'debug', 'default-signal', 'ignore-signal', 'block-signal', 'list-signal-handling', 'version', 'help'];
const ENV_LONG_VALUE = new Set(['unset', 'chdir', 'split-string', 'argv0']);
function envOption(f, args, i, dirs, splits) {
  const take = (kind, val, hasVal) => {
    if (!hasVal) { val = i < args.length ? args[i] : undefined; i++; }
    if (val === undefined) return;
    if (kind === 'C') addDir(dirs, val);
    else if (kind === 'S') splits.push(val);
  };
  if (f.startsWith('--')) {
    const eq = f.indexOf('=');
    const key = eq < 0 ? f.slice(2) : f.slice(2, eq);
    if (!key) return i;
    const names = ENV_LONG.filter((n) => n.startsWith(key));
    const name = names.includes(key) ? key : names.length === 1 ? names[0] : null;
    if (name && ENV_LONG_VALUE.has(name)) {
      take(name === 'chdir' ? 'C' : name === 'split-string' ? 'S' : 'u', eq < 0 ? undefined : f.slice(eq + 1), eq >= 0);
    }
    return i;
  }
  for (let k = 1; k < f.length; k++) {
    const c = f[k];
    if (c === 'C' || c === 'S' || c === 'u' || c === 'a') { take(c, f.slice(k + 1), k + 1 < f.length); break; }
  }
  return i;
}

/* The words of a command after wrappers that only run it (sudo, env, VAR=x, nohup, nice, time ...) and shell keywords,
   with the words of the env -C / --chdir and sudo -D / --chdir options: { args, dir, overflow } (dir = null when none;
   overflow = more wrappers than can be followed). */
function unwrapDir(args) {
  let i = 0;
  const dirs = [];
  const splits = [];
  // Where the words after the last -S value start: the string is read in place of the option, so what follows it
  // (options env had taken, such as the -rf of env -S "-S rm" -rf DIR) belongs to the command the string names.
  let splitEnd = -1;
  let overflow = false;
  // Set when the chain may not end on the program (see policy.skipWrapper): the caller also reads the later words.
  const chain = { unsure: false };
  // Where the first wrapper starts: when the chain is unsure, the words it skipped as option values are read as commands too.
  let first = -1;
  for (let guard = 0; i < args.length; guard++) {
    // Assignments and keywords can repeat without limit (! ! ! rm -rf ~): they are skipped, not counted as wrappers.
    // So are the words that only introduce a command: function NAME { ...; } (the body is read like any other commands,
    // called or not) and coproc [NAME] { ...; } / coproc CMD (the command runs as a background job).
    while (i < args.length) {
      const w = args[i];
      if (ASSIGN_RE.test(w) || SHELL_KEYWORDS.has(w) || RUN_NEXT_WORDS.has(w.toLowerCase())) i++;
      else if (w === 'function' && i + 1 < args.length) i += 2;
      else if (w === 'coproc') i += i + 2 < args.length && SHELL_KEYWORDS.has(args[i + 2]) ? 2 : 1;
      else break;
    }
    if (i >= args.length) break;
    const a = args[i];
    const name = programName(a);
    // The guard is used up and the next word is still a wrapper: the rest cannot be read, so the line is refused.
    if (guard >= 32) { overflow = WRAPPERS.has(name) || policyModule().WRAPPER_NAMES.has(name); break; }
    if (first < 0 && (name === 'sudo' || name === 'doas' || name === 'env' || name === 'start' || policyModule().WRAPPER_NAMES.has(name))) first = i;
    // cmd.exe's start [title] [/options] command: the options and an empty title are skipped. A title or an option
    // value may also be taken for the program, so the chain is unsure and the later words are read as well.
    if (name === 'start') {
      i++;
      while (i < args.length && (args[i] === '' || /^\/[A-Za-z]+$/.test(args[i]))) {
        i += /^\/(?:d|affinity|node)$/i.test(args[i]) ? 2 : 1;
      }
      chain.unsure = true;
      continue;
    }
    if (name === 'sudo' || name === 'doas') {
      i++;
      while (i < args.length && args[i].startsWith('-')) {
        const f = args[i++];
        if (f === '-D' || f === '--chdir') { addDir(dirs, args[i++]); continue; }
        if (/^-D./.test(f)) { addDir(dirs, f.slice(2)); continue; }
        if (f.startsWith('--chdir=')) { addDir(dirs, f.slice(8)); continue; }
        if (SUDO_ARG_FLAGS.has(f)) { i++; continue; }
        // A flag zn does not know may take a value (a cluster such as -Eu root, a newer option).
        if (!/^--[^=]+=/.test(f)) chain.unsure = true;
      }
      continue;
    }
    if (name === 'env') {
      i++;
      while (i < args.length && (args[i].startsWith('-') || ASSIGN_RE.test(args[i]))) {
        const f = args[i++];
        if (!f.startsWith('-')) continue;
        const before = splits.length;
        i = envOption(f, args, i, dirs, splits);
        if (splits.length > before) splitEnd = i;
      }
      continue;
    }
    // Every other wrapper of the shared list (nohup, nice, ionice, timeout, stdbuf, command, exec, xargs, busybox ...).
    const P = policyModule();
    if (P.WRAPPER_NAMES.has(name)) {
      i = P.skipWrapper(args, i, name, chain);
      continue;
    }
    break;
  }
  return { args: args.slice(i), dir: dirs.length ? dirs : null, splits, splitTail: splitEnd >= 0 ? args.slice(splitEnd) : [], overflow, unsure: chain.unsure, all: first >= 0 ? args.slice(first) : args };
}

/* The words of a command after wrappers and shell keywords. */
function unwrap(args) { return unwrapDir(args).args; }

/* Resolves "." and ".." segments lexically (no filesystem) for a path that starts at a known point: "/", a drive, or a home word.
   A ".." above "/" or a drive root stays there; a ".." that steps out of the home folder names its parent. Relative paths are left alone. */
function resolveDots(t) {
  if (!/(?:^|\/)\.\.?(?:\/|$)/.test(t)) return t;
  let anchor = '';
  let rest = t;
  let home = false;
  const drive = /^[A-Za-z]:(?:\/|$)/.exec(t);
  if (t.startsWith('/')) { anchor = '/'; rest = t.slice(1); }
  else if (drive) { anchor = t.slice(0, 2) + '/'; rest = t.slice(drive[0].length); }
  else {
    const first = t.split('/')[0];
    if (!HOME_WORDS.has(first.toLowerCase())) return t;
    anchor = first + '/'; rest = t.slice(first.length + 1); home = true;
  }
  const out = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg !== '..') { out.push(seg); continue; }
    if (out.length) out.pop();
    else if (home) return '/home';
  }
  return anchor + out.join('/');
}

/* The dangerous path a word names, as 'root', 'home' or 'system', or ''. */
function dangerousPath(word) {
  let t = String(word).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!t) return '';
  // \\?\C:\ and \\.\C:\ are the long-path spellings of C:\; %SystemDrive% and $env:SystemDrive name the drive.
  t = t.replace(/^\/[?.]\/(?=[A-Za-z]:)/, '').replace(DRIVE_VAR_RE, 'C:').replace(WINDIR_VAR_RE, 'C:/Windows');
  t = resolveDots(t);
  // Trailing "/", "/*", "/.*", "/." and a bare "*" (a PowerShell "~\*" reaches the tokenizer as "~*") name the same folder.
  for (let n = 0; n < 4; n++) {
    let s = t.replace(/\/(?:\*|\.\*|\.|\{\*,\.\*\})?$/, '');
    if (s === t && t.length > 1 && t.endsWith('*')) s = t.slice(0, -1);
    if (s === t) break;
    t = s;
    if (t === '') return 'root';
  }
  if (t === '*') return '';
  const low = t.toLowerCase();
  if (HOME_WORDS.has(low)) return 'home';
  if (SYSTEM_DIRS.has(t)) return 'system';
  if (/^\/(?:home|Users)\/[^/*.][^/*]*$/.test(t)) return 'home';
  if (/^[A-Za-z]:$/.test(t)) return 'root';
  if (/^[A-Za-z]:\/(?:windows|windows\/system32|users|program files|program files \(x86\)|programdata)$/i.test(t)) return 'system';
  if (/^[A-Za-z]:\/users\/[^/*]+$/i.test(t)) return 'home';
  return '';
}

// cmd.exe options joined in one word (/s/q, /A:-h/S): one pass, each option is / and a letter with an optional :value.
const CMD_OPTS_RE = /^(?:\/[A-Za-z](?::[-A-Za-z]*)?)+$/;

function recursiveFlag(w, head) {
  // PowerShell: a backtick inside a parameter name is dropped (-Rec`urse), and -Recurse:$true is -Recurse.
  if (w.includes('`')) w = w.replace(/`/g, '');
  const ps = /^(-[A-Za-z]+):(\S*)$/.exec(w);
  if (ps) {
    if (['$false', 'false', '0', '$null'].includes(ps[2].toLowerCase())) return false;
    w = ps[1];
  }
  if (CMD_HEADS.has(head) && CMD_OPTS_RE.test(w) && w.split('/').some((o) => o.toLowerCase() === 's')) return true;
  // rm's own short flags only, so PowerShell's -Force is not read as a bundle with an r in it.
  if (/^-[fiIrRdvx]*[rR][fiIrRdvx]*$/.test(w) || w === '--recursive') return true;
  return /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?$/i.test(w);
}

// cmd.exe options may be joined (/s/q) and written in either case (/S /Q); del takes /A:attributes.
function isCmdFlag(w, head) { return CMD_HEADS.has(head) && /^(?:\/[sqfa](?::?[-A-Za-z]*)?)+$/i.test(w); }

// PowerShell's -Path:C:\ and -LiteralPath:C:\ give the path in the same word as the parameter.
const PS_PATH_PARAM_RE = /^-(?:path|literalpath|lp|pspath):(.+)$/is;

/* Words after the command name that are not flags (everything after "--" counts). */
function operands(args, head) {
  const out = [];
  let rest = false;
  for (const w of args) {
    if (!rest && w === '--') { rest = true; continue; }
    if (!rest && (w.startsWith('-') || isCmdFlag(w, head))) {
      const m = RM_HEADS.has(head) ? PS_PATH_PARAM_RE.exec(w) : null;
      if (m) out.push(m[1]);
      continue;
    }
    out.push(w);
  }
  return out;
}

function redirectTargets(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d*>>?\|?$/.test(w)) { if (i + 1 < words.length) out.push(words[i + 1]); continue; }
    const m = /^\d*>>?\|?(.+)$/.exec(w);
    if (m) out.push(m[1]);
  }
  return out;
}

/* The interpreter family of a program name ('py', 'node', 'perl', 'ruby'), or ''. */
function interpreterKind(head) {
  if (!INTERPRETER_RE.test(head)) return '';
  if (head === 'py' || head.startsWith('py')) return 'py';
  return head.startsWith('node') ? 'node' : head;
}

/* The code strings given on the command line of an interpreter (python -c CODE, node -e CODE, perl -e CODE, ruby -e CODE). */
function interpreterCode(kind, rest) {
  const def = INTERPRETERS[kind];
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === '--' || !w.startsWith('-')) break;
    if (def.code.test(w)) {
      if (i + 1 < rest.length) out.push(rest[i + 1]);
      i++;
      if (kind === 'py' || kind === 'node') break;
      continue;
    }
    const m = kind === 'node' ? /^--(?:eval|print)=([\s\S]*)$/.exec(w) : null;
    if (m) { out.push(m[1]); break; }
    if (def.skip.has(w)) i++;
  }
  return out;
}

/* True when the first argument of a delete call names the home folder, the root or a system folder. */
function protectedArgument(tail) {
  let t = tail.replace(/^\s{0,20}/, '');
  const wrap = OI_PATH_WRAP_RE.exec(t);
  if (wrap) t = t.slice(wrap[0].length);
  const home = OI_HOME_RE.exec(t);
  if (home) return /^\s{0,20}(?:[,)}\]]|$)/.test(t.slice(home[0].length));
  const lit = OI_LITERAL_RE.exec(t);
  return Boolean(lit) && Boolean(dangerousPath(lit[2].replace(OI_ENV_HOME_RE, '~')));
}

/* True when interpreter code calls a recursive delete on the home folder, the root or a system folder. */
function codeDeletesProtected(code) {
  for (const m of code.matchAll(OI_CALL_RE)) {
    const name = m[1];
    if (OI_NEEDS_PAREN.has(name) && !m[2]) continue;
    const from = m.index + m[0].length;
    const tail = code.slice(from, from + 300);
    if (OI_NEEDS_RECURSIVE.has(name) && !OI_RECURSIVE_RE.test(tail)) continue;
    if (protectedArgument(tail)) return true;
  }
  for (const m of code.matchAll(OI_GLOB_RE)) {
    const from = m.index + m[0].length;
    if (protectedArgument(code.slice(from, from + 300))) return true;
  }
  return false;
}

/* True when an interpreter in a pipeline reads its program from the pipe: no script file, -c, -e or -m. */
function readsScriptFromStdin(kind, rest) {
  const def = INTERPRETERS[kind];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === '-') return true;
    if (def.noStdin.test(w)) return false;
    if (w.startsWith('-')) { if (def.skip.has(w)) i++; continue; }
    return false; // a script file: stdin is only data for it
  }
  return true;
}

function checkSimple(words, depth, known) {
  const un = unwrapDir(words);
  const args = un.args;
  if (un.overflow) return OVERFLOW;
  if (un.dir !== null) {
    known = inDir(known, un.dir);
    if (known === CWD_OVERFLOW) return OVERFLOW;
  }
  // env -S "rm -rf ~": the split strings (env joins their words in order) are a command line of its own, followed by the
  // words after them. One reading for all of them, so the cost does not multiply with the number of -S options.
  // Strings inside strings (env -S "env -S 'rm -rf /home/alice'", env -S "-S rm -rf /home/alice") are read again the same
  // way, up to MAX_DEPTH levels; a deeper one is refused, not skipped.
  if (un.splits.length && depth >= MAX_DEPTH) return ENABLED === null || ENABLED.size > 0 ? OVERFLOW : null;
  if (un.splits.length) {
    const tail = un.splitTail.map((w) => "'" + w.replace(/'/g, "'\\''") + "'").join(' ');
    // The string is read as the rest of an env command, so env options inside it (-i, -u NAME, -C DIR, -S) are read too.
    const text = un.splits.map((x) => x.replace(/\\_/g, ' ').replace(/\\[tnvfr]/g, ' ')).join(' ');
    const hit = analyze('env ' + text + ' ' + tail, depth + 1, known);
    if (hit) return hit;
  }
  if (!args.length) return null;
  const hit = checkHead(args, depth, known);
  if (hit || !un.unsure) return hit;
  // From the first wrapper on, so a word skipped as an option's value is read as a possible command as well.
  return checkLaterHeads(un.all, depth, known);
}

/* Whether the rules below read a command with this program name as its head. */
function headIsRead(name) {
  return RM_HEADS.has(name) || DISK_TOOLS.test(name) || SHELLS.has(name) || POWERSHELLS.has(name) || name === 'su' || name === 'eval' ||
    name === 'iex' || name === 'invoke-expression' ||
    name === 'cmd' || name === 'find' || name === 'chmod' || name === 'chown' || name === 'chgrp' || name === 'dd' || Boolean(interpreterKind(name));
}

/* A wrapper chain that may not end on the program (an option zn does not know may have taken the next word as its value):
   each later word that names a program these rules read is checked as the head too, so the option cannot hide the command. */
function checkLaterHeads(args, depth, known) {
  let n = 0;
  for (let j = 1; j < args.length; j++) {
    if (!headIsRead(programName(args[j]))) continue;
    if (++n > LATER_HEADS_MAX) return OVERFLOW;
    const hit = checkHead(args.slice(j), depth, known);
    if (hit) return hit;
  }
  return null;
}

const PS_VALUE_OPTS = new Set(['-executionpolicy', '-ep', '-ex', '-windowstyle', '-w', '-win', '-inputformat', '-if', '-outputformat', '-of', '-o',
  '-configurationname', '-workingdirectory', '-wd', '-settingsfile', '-version', '-v', '-psconsolefile', '-custompipename',
  '-encodedarguments', '-ea']);

/* powershell Remove-Item ...: Windows PowerShell runs the words after its options as a command when no -Command, -File or
   -EncodedCommand is given. A first word that names a .ps1 file is a script, not code. */
function psPositionalCode(rest) {
  let j = 0;
  while (j < rest.length && rest[j].startsWith('-')) {
    const opt = rest[j].toLowerCase();
    if (['-file', '-f', '-encodedcommand', '-enc', '-ec', '-e'].includes(opt)) return null;
    j += PS_VALUE_OPTS.has(opt) ? 2 : 1;
  }
  if (j >= rest.length || rest[j].toLowerCase().endsWith('.ps1')) return null;
  return rest.slice(j).join(' ');
}

/* The rules for one simple command whose head is args[0]. */
function checkHead(args, depth, known) {
  const head = programName(args[0]);
  const rest = args.slice(1);

  // Shell code inside the command: sh -c "...", eval "...", pwsh -Command "...", cmd /c "...", su -c "..."
  let code = null;
  if (SHELLS.has(head) || head === 'su') {
    const k = rest.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    if (k >= 0 && k + 1 < rest.length) code = rest[k + 1];
  } else if (head === 'eval' || head === 'iex' || head === 'invoke-expression') {
    code = rest.join(' ');
  } else if (POWERSHELLS.has(head)) {
    const k = rest.findIndex((w) => /^-c(?:ommand)?$/i.test(w));
    code = k >= 0 ? rest.slice(k + 1).join(' ') : psPositionalCode(rest);
  } else if (head === 'cmd') {
    const k = rest.findIndex((w) => /^\/[ck]$/i.test(w));
    if (k >= 0) code = rest.slice(k + 1).join(' ');
  }
  // The code is a download in a substitution (X="$(curl URL)"; sh -c "$X"): the same as sh -c "$(curl URL)".
  if (code !== null && (SHELLS.has(head) || head === 'su' || head === 'eval') && /^\s*(?:\$\(|`)/.test(code) && SHELL_RUNS_DOWNLOAD_RE.test('sh -c "' + code + '"') && on('pipe_to_shell')) return 'pipe_to_shell';
  if (code !== null && depth < MAX_DEPTH) {
    const hit = analyze(code, depth + 1, known);
    if (hit) return hit;
  }

  // Code an interpreter runs from its command line: python -c, node -e, perl -e, ruby -e.
  const kind = interpreterKind(head);
  if (kind && on('rm_root_home') && interpreterCode(kind, rest).some((c) => codeDeletesProtected(c))) return 'rm_root_home';

  if (RM_HEADS.has(head)) {
    if ((rest.some((w) => recursiveFlag(w, head)) && operands(rest, head).some((w) => dangerousPath(fromCwd(known, w)))) && on('rm_root_home')) return 'rm_root_home';
  }
  if (head === 'find') {
    const paths = [];
    // GNU find takes -P, -L, -H, -O<level> and -D <options> before the starting paths; they do not end the list of paths.
    let first = 0;
    while (first < rest.length) {
      if (/^-(?:[PLH]|O\d*)$/.test(rest[first])) first += 1;
      else if (rest[first] === '-D') first += 2;
      else break;
    }
    for (const w of rest.slice(first)) { if (w.startsWith('-') || w === '(' || w === '!') break; paths.push(w); }
    // After a cd to a protected folder, a find with no path starts at ".".
    if (known && !paths.length) paths.push('.');
    // -execdir, -ok and -okdir run the program like -exec does (in the folder of each file, or after a prompt).
    const del = rest.includes('-delete') || rest.some((w, i) => /^-(?:exec|execdir|ok|okdir)$/.test(w) && /^(?:rm|shred)$/.test(programName(rest[i + 1] || '')));
    // With a test (-name, -type, -mtime ...) find removes only some files; with none it removes everything below the path.
    // From the filesystem root even a filtered delete is refused: a test does not make that safe.
    const filtered = rest.some((w) => FIND_TESTS.test(w));
    const fromRoot = paths.some((w) => dangerousPath(fromCwd(known, w)) === 'root');
    if ((del && (!filtered || fromRoot) && paths.some((w) => dangerousPath(fromCwd(known, w)))) && on('rm_root_home')) return 'rm_root_home';
    // -files0-from FILE (or - for stdin) loads the starting paths from a file the command text does not show, so a delete
    // over them cannot be checked: refuse it (fail closed). It is never read. Non-deleting uses (-print) stay allowed.
    if ((del && rest.includes('-files0-from')) && on('rm_root_home')) return 'rm_root_home';
  }
  if (head === 'chmod' || head === 'chown' || head === 'chgrp') {
    if (rest.some((w) => /^-[A-Za-z]*R[A-Za-z]*$/.test(w) || w === '--recursive')) {
      const ops = operands(rest, head);
      const mode = ops[0] || '';
      const targets = ops.slice(1).map((w) => dangerousPath(fromCwd(known, w))).filter(Boolean);
      if ((targets.includes('root') || targets.includes('system')) && on('perm_root')) return 'perm_root';
      if ((head === 'chmod' && targets.includes('home') && worldWritable(mode)) && on('perm_root')) return 'perm_root';
    }
  }
  if (head === 'dd') {
    if ((rest.some((w) => w.startsWith('of=') && BLOCK_DEVICE_RE.test(w.slice(3)))) && on('disk_overwrite')) return 'disk_overwrite';
  }
  if ((DISK_TOOLS.test(head) && rest.some((w) => BLOCK_DEVICE_RE.test(w))) && on('disk_overwrite')) return 'disk_overwrite';
  return null;
}

function worldWritable(mode) {
  if (/^0?[0-7]{2}[2367]$/.test(mode) || /^[0-7]{4}$/.test(mode) && /[2367]$/.test(mode)) return true;
  const m = /^([ugoa]*)[+=][rwxXst]*w[rwxXst]*$/.exec(mode);
  return Boolean(m && (m[1] === '' || /[ao]/.test(m[1])));
}

function isRcPath(w) {
  const t = String(w).replace(/\\/g, '/').replace(/^~\//, '/').replace(/^\$\{?home\}?\//i, '/');
  return RC_UNIX_RE.test(t) || RC_PS_RE.test(String(w));
}

/* The flag before the file a download is saved to: curl -o / --output, wget -O / --output-document, iwr -OutFile. */
function outFlag(w) {
  return /^-[A-Za-z]*[oO]$/.test(w) || /^--output(?:-document)?$/.test(w) || /^-out(?:f(?:i(?:l(?:e)?)?)?)?$/i.test(w);
}

/* {x..y} with one-character ends or one- and two-digit numbers, as the comma list bash expands it to ({u..u} -> u). */
function expandSequences(w) {
  return w.replace(/\{(?:([A-Za-z])\.\.([A-Za-z])|(\d{1,2})\.\.(\d{1,2}))\}/g, (all, a, b, n, m) => {
    const chr = a !== undefined;
    // mixed case: bash also walks the characters between the two, not worth following
    if (chr && (a < 'a') !== (b < 'a')) return all;
    const from = chr ? a.charCodeAt(0) : Number(n);
    const to = chr ? b.charCodeAt(0) : Number(m);
    const step = from <= to ? 1 : -1;
    const list = [];
    for (let c = from; ; c += step) {
      list.push(chr ? String.fromCharCode(c) : String(c));
      if (c === to) break;
    }
    return list.length === 1 ? list[0] : '{' + list.join(',') + '}';
  });
}

/* The words a brace list in `w` expands to (c{u,}rl -> curl, cl); just `w` when there is none, and null when there
   are too many: the caller reads that as a match, since the shell runs the first alternative and any of them may be it. */
function braceAlts(w) {
  return policyModule().expandBraces(expandSequences(String(w)));
}

function isRcTarget(w) {
  const alts = braceAlts(w);
  return alts === null || alts.some(isRcPath);
}

/* The words of a command without its redirections and their targets (>> ~/.bashrc curl URL is curl URL). */
function stripRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d*[<>]>?\|?$/.test(w)) { i++; continue; }
    if (/^\d*[<>]>?\|?[^<>(\s]/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/* The folder a segment of a pipeline runs in: `known` (null = unknown) moved by an env -C / sudo -D in front of it. */
function segmentDir(known, dir) {
  return dir === null ? known : inDir(known, dir);
}

/* The words of a pipeline segment from its program on. When the wrapper chain may not end on the program (unwrapDir's
   unsure) and its head is not a downloader, shell or interpreter, the first later word that is one starts it
   (curl URL | nice --adj 5 sh). */
function pipeArgs(un) {
  const a = un.args;
  if (!un.unsure || a.length < 2) return a;
  const isProg = (w) => { const n = programName(w); return DOWNLOADERS.has(n) || SHELLS.has(n) || Boolean(interpreterKind(n)); };
  if (isProg(a[0])) return a;
  const j = a.findIndex((w, i) => i > 0 && isProg(w));
  return j > 0 ? a.slice(j) : a;
}

/* A redirect written against the word before it (curl URL>> ~/.bashrc, curl URL>~/.bashrc) is a word of its own: the
   shell ends a word at >. A word of digits only before > is a file descriptor (2>), so it stays as it is. */
function splitGluedRedirects(words) {
  if (!words.some((w) => w.includes('>'))) return words;
  const out = [];
  for (const w of words) {
    const i = w.indexOf('>');
    if (i > 0 && !/^\d+$/.test(w.slice(0, i)) && w[0] !== '<' && w[0] !== '>') out.push(w.slice(0, i), w.slice(i));
    else out.push(w);
  }
  return out;
}

/* The words of a pipeline command from its program on, the program names it may be (brace lists), whether there are too
   many of them, and its env -C / sudo -D folders. env -S 'curl URL' and eval curl URL run the words they are given. */
function pipeHead(words) {
  const un = unwrapDir(stripRedirects(words));
  let a = un.args;
  if (un.splits.length) a = un.splits.join(' ').split(/\s+/).filter(Boolean).concat(a);
  if (a.length && programName(a[0]) === 'eval') a = a.slice(1).join(' ').split(/\s+/).filter(Boolean);
  a = pipeArgs({ args: a, unsure: un.unsure });
  const alts = a.length ? braceAlts(a[0]) : [''];
  const names = (alts || [String(a[0])]).map(programName);
  return { args: a, names, overflow: alts === null, dir: un.dir };
}

function runsDownload(words) {
  const h = pipeHead(words);
  return h.overflow || h.names.some((n) => DOWNLOADERS.has(n));
}

/* `fds` holds the files that exec opened earlier on the line (exec 3>> ~/.bashrc), by descriptor. */
function checkPipeline(pipe, known = null, fds = null) {
  pipe = pipe.map((s) => ({ words: splitGluedRedirects(s.words), sep: s.sep }));
  const heads = pipe.map((s) => {
    const h = pipeHead(s.words);
    return { args: h.args, head: h.names[0], names: h.names, overflow: h.overflow, dir: segmentDir(known, h.dir) };
  });
  if (heads.some((h) => h.dir === CWD_OVERFLOW)) return OVERFLOW;
  const firstDl = heads.findIndex((h) => h.overflow || h.names.some((n) => DOWNLOADERS.has(n)));
  if (firstDl >= 0) {
    // a download whose output reaches a shell
    for (let j = firstDl + 1; j < pipe.length; j++) {
      const h = heads[j];
      // an interpreter that reads its program from the pipe (python3, python3 -, node, perl, ruby)
      const interp = h.overflow || h.names.some((n) => SHELLS.has(n)) ? '' : h.names.map(interpreterKind).find(Boolean);
      if (interp) {
        if (readsScriptFromStdin(interp, h.args.slice(1)) && on('pipe_to_shell')) return 'pipe_to_shell';
        continue;
      }
      if (!h.overflow && !h.names.some((n) => SHELLS.has(n))) continue;
      const rest = h.args.slice(1);
      // -c runs the code of its argument (checked on its own); -n only reads the script to check its syntax.
      if (rest.some((w) => /^-[A-Za-z]*[cn][A-Za-z]*$/.test(w))) continue;
      const files = rest.filter((w) => !w.startsWith('-'));
      if ((!files.length || rest.includes('-s') || rest.includes('-')) && on('pipe_to_shell')) return 'pipe_to_shell';
    }
    // a download written into a startup file
    for (let j = 0; j < pipe.length; j++) {
      const words = pipe[j].words;
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const prev = i > 0 ? words[i - 1] : '';
        let target = null;
        const dup = /^\d*>>?_(\d+)$/.exec(w);
        if (/^\d*>>?\|?$/.test(prev)) target = w;
        // >&3 writes to the file descriptor 3 that an earlier exec 3>> FILE opened.
        else if (dup) target = fds && fds.has(dup[1]) ? fds.get(dup[1]) : null;
        else if (/^\d*>>?\|?.+$/s.test(w)) target = w.replace(/^\d*>>?\|?/, '');
        else if (outFlag(prev)) target = w;
        else if (/^(?:--output|--output-document|-OutFile)[=:]/i.test(w)) target = w.replace(/^[^=:]*[=:]/, '');
        else if (/^-[A-Za-z]*?[oO][^\s]/.test(w)) target = w.replace(/^-[A-Za-z]*?[oO]/, ''); // curl -o$HOME/.bashrc
        else if (heads[j].head === 'tee' && !w.startsWith('-') && i > 0) target = w;
        else if (heads[j].head === 'dd' && w.startsWith('of=')) target = w.slice(3);
        // A relative file is read from the folder an earlier cd, pushd or env -C moved to.
        if ((target !== null && isRcTarget(fromCwd(heads[j].dir, target))) && on('rc_download')) return 'rc_download';
      }
    }
  }
  // A redirect to a block device, with or without a download.
  for (const s of pipe) {
    for (const t of redirectTargets(s.words)) if ((BLOCK_DEVICE_RE.test(t)) && on('disk_overwrite')) return 'disk_overwrite';
  }
  return null;
}

// The rules the current call looks for (null = all six). Set by checkCommand and denial; the check is synchronous.
let ENABLED = null;
function on(rule) { return ENABLED === null || ENABLED.has(rule); }

// Most backtick substitutions read from a changed folder in one command line; past it the line is refused.
const MAX_TICK_READS = 200;

/* `cwd0` is the folder a cd or pushd earlier in the same command line moved to (null = unknown). A cd inside a pipeline or a background command runs in a subshell and does not count. */
/* PowerShell ($D = 'C:\', $env:D = ...) and cmd.exe (set D=C:\) variables, kept next to the POSIX ones of shell-vars in
   the same scope (same caps and counters); both ignore case. */
const PS_ASSIGN_RE = /^\$\{?((?:env:)?[A-Za-z_][A-Za-z0-9_]*)\}?(=([\s\S]*))?$/i;
const PS_REF_RE = /\$(?:\{((?:env:)?[A-Za-z_][A-Za-z0-9_]*)\}|((?:env:)?[A-Za-z_][A-Za-z0-9_]*))/gi;
const CMD_REF_RE = /%([A-Za-z_][A-Za-z0-9_]*)%|!([A-Za-z_][A-Za-z0-9_]*)!/g;
const VAR_ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;

function newVarScope() {
  const scope = shellVars.newScope();
  scope.ps = new Map();
  scope.cmd = new Map();
  return scope;
}

function winValue(scope, v, whole) {
  if (v === undefined) return whole;
  scope.expanded += v.length;
  return scope.expanded > shellVars.MAX_EXPANDED ? whole : v;
}

function winSubstitute(scope, word) {
  if (scope.ps.size && word.includes('$')) word = word.replace(PS_REF_RE, (all, b, p) => winValue(scope, scope.ps.get((b || p).toLowerCase()), all));
  if (scope.cmd.size && (word.includes('%') || word.includes('!'))) word = word.replace(CMD_REF_RE, (all, a, b) => winValue(scope, scope.cmd.get((a || b).toLowerCase()), all));
  return word;
}

function winRecord(scope, table, name, value) {
  if (++scope.assignments > shellVars.MAX_ASSIGNMENTS) scope.overflow = true;
  else if (value.length > shellVars.MAX_VALUE) table.delete(name);
  else table.set(name, value);
}

/* A PowerShell assignment ($D = 'C:\', $D='C:\', $env:D = ...) or a cmd.exe set D=C:\ line. Recorded even before a &
   (in cmd.exe it only separates commands), which can only add blocks. */
function winRecordWords(scope, out) {
  if (!out.length) return;
  if (out[0].startsWith('$')) {
    const m = PS_ASSIGN_RE.exec(out[0]);
    if (!m) return;
    let value = null;
    if (m[2] === undefined && out.length === 3 && out[1] === '=') value = out[2];
    else if (m[2] !== undefined && m[3] && out.length === 1) value = m[3];
    else if (m[2] !== undefined && !m[3] && out.length === 2) value = out[1];
    if (value !== null) winRecord(scope, scope.ps, m[1].toLowerCase(), value);
  } else if (out[0].toLowerCase() === 'set' && out.length === 2) {
    const m = VAR_ASSIGN_RE.exec(out[1]);
    if (m) winRecord(scope, scope.cmd, m[1].toLowerCase(), m[2]);
  }
}

/* The words of one simple command with the known POSIX, PowerShell and cmd.exe variables filled in, and any assignment
   it makes recorded. */
function applyVars(scope, words, sep) {
  let out = shellVars.applyWords(scope, words, sep);
  if (scope.overflow) return out;
  if (scope.ps.size || scope.cmd.size) out = out.map((w) => winSubstitute(scope, w));
  if (sep !== '|' && sep !== '|&') winRecordWords(scope, out);
  return out;
}

// ${NAME:-word}, ${NAME-word}, ${NAME:=word}, ${NAME=word}, ${NAME:+word}, ${NAME+word} and ${NAME:?word} with no brace
// inside (an inner one is read first, so nested defaults are followed from the inside out).
const DEFAULT_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-=+?])([^{}]*)\}/;
// Readings of one simple command (one per choice of default values); past it every alternative is still read once.
const MAX_VARIANTS = 64;
// Words one brace expansion may give (rm -rf build{1..99} is 99); past it the word is too many to follow.
const BRACE_WORDS_MAX = 1024;
// Words a simple command may have after brace expansion.
const EXPANDED_WORDS_MAX = 4096;

/* The words a word with default-value expansions may become: the variable's value when the line assigned it, else both
   the variable (unknown) and the default word; null when there are more than MAX_VARIANTS. */
function defaultAlts(word, scope) {
  if (!word.includes('${') || !DEFAULT_RE.test(word)) return [word];
  const out = [];
  const work = [word];
  let steps = 0;
  while (work.length) {
    const w = work.pop();
    const m = DEFAULT_RE.exec(w);
    if (!m) {
      if (!out.includes(w)) out.push(w);
      if (out.length > MAX_VARIANTS) return null;
      continue;
    }
    if (++steps > MAX_VARIANTS * 8) return null;
    const [, name, op, dflt] = m;
    const known = scope.vars.get(name);
    const colon = op.startsWith(':');
    let choices;
    if (op.endsWith('+')) choices = known === undefined ? ['', dflt] : (known || !colon) ? [dflt] : [''];
    else if (op.endsWith('?')) choices = known === undefined ? ['$' + name] : [known];
    else if (known === undefined) choices = ['$' + name, dflt];
    else choices = colon && !known ? [dflt] : [known];
    for (let c = choices.length - 1; c >= 0; c--) work.push(w.slice(0, m.index) + choices[c] + w.slice(m.index + m[0].length));
  }
  return out;
}

/* The words a word with brace lists becomes ({rm,-rf,/} is rm -rf /), or null when there are too many. */
function braceWords(w) {
  if (!w.includes('{') || (!w.includes(',') && !w.includes('..'))) return [w];
  return policyModule().expandBraces(expandSequences(w), BRACE_WORDS_MAX);
}

/* The readings of one simple command after default-value and brace expansion: the first is the words as written; there
   is one more for each choice of default values (or, past MAX_VARIANTS, enough for each alternative of each word to be
   read once). null when a word expands to more words than can be followed and the command is one these rules read: the
   caller refuses the line. */
function wordReadings(words, scope) {
  if (!words.some((w) => w.includes('{'))) return [words];
  const perWord = [];
  let total = 1;
  let tooMany = false;
  let prefix = true; // still in the assignment words before the command
  for (const w of words) {
    let alts = w.includes('${') ? defaultAlts(w, scope) : [w];
    if (alts === null) { tooMany = true; alts = [w]; }
    const group = [];
    const assign = prefix && ASSIGN_RE.test(w);
    prefix = assign;
    for (const a of alts) {
      // An assignment word before the command (X={a,b} cmd) is not brace-expanded by the shell.
      if (assign) { group.push([a]); continue; }
      let bw = braceWords(a);
      if (bw === null) { tooMany = true; bw = [a]; }
      group.push(bw);
    }
    perWord.push(group);
    total = Math.min(total * group.length, MAX_VARIANTS + 1);
  }
  const anyRead = () => words.some((w) => headIsRead(programName(w)));
  if (tooMany && anyRead()) return null;
  let combos;
  if (total <= MAX_VARIANTS) {
    combos = [[]];
    for (const g of perWord) {
      const next = [];
      for (const c of combos) for (const x of g) next.push(c.concat([x]));
      combos = next;
    }
  } else {
    const width = perWord.reduce((m, g) => Math.max(m, g.length), 1);
    combos = [];
    for (let k = 0; k < width; k++) combos.push(perWord.map((g) => g[Math.min(k, g.length - 1)]));
  }
  // The words as written come first: the pipeline rules read a brace list in a program name as alternatives
  // (curl URL | s{h,} counts as a pipe into sh), which a split into words would lose.
  const out = [words];
  const seen = new Set([words.join('\0')]);
  for (const combo of combos) {
    let flat = combo.flat();
    if (flat.length > EXPANDED_WORDS_MAX) {
      if (anyRead()) return null;
      flat = words;
    }
    const key = flat.join('\0');
    if (!seen.has(key)) { seen.add(key); out.push(flat); }
  }
  return out;
}

/* Close the innermost group; a download inside it is also inside the group around it. */
function closeGroup(dlGroups) {
  const had = dlGroups.pop();
  if (had && dlGroups.length) dlGroups[dlGroups.length - 1] = true;
  return had;
}

/* The files an exec line opens for writing: exec 3>> FILE, exec 3>FILE. */
function recordFds(words, fds) {
  for (let i = 0; i < words.length; i++) {
    const m = /^(\d+)>>?\|?(.*)$/s.exec(words[i]);
    if (!m) continue;
    const target = m[2] || (i + 1 < words.length ? words[i + 1] : '');
    if (target && fds.size < shellVars.MAX_ASSIGNMENTS) fds.set(m[1], target);
  }
}

/* The pipeline rules for each reading k: every command takes its own reading k (or its last one). */
function checkPipelineReadings(pipe, readings, known, fds) {
  const width = readings.reduce((m, r) => Math.max(m, r.length), 1);
  if (width === 1 && readings.every((r, i) => r[0] === pipe[i].words)) return checkPipeline(pipe, known, fds);
  for (let k = 0; k < width; k++) {
    const hit = checkPipeline(pipe.map((s, i) => ({ words: readings[i][Math.min(k, readings[i].length - 1)], sep: s.sep })), known, fds);
    if (hit) return hit;
  }
  return null;
}

function checkSegments(segs, depth, cwd0 = null) {
  let pipe = [];
  // The readings of each command of the pipeline (default values and brace lists), see wordReadings.
  let pipeReadings = [];
  let known = cwd0; // the folder reached so far: a chain, CWD_LOST, or null when unknown
  // A ( group runs in a subshell: a cd inside it does not move the folder of what follows the ). Each "(" saves the folder.
  const groups = [];
  let ticks = 0;
  const vars = newVarScope();
  // One entry per open { } or ( ) group: whether a download ran inside it. The output of the group is the output of that
  // download, so the command that closes it ({ curl URL; } | sh, (curl URL) >> ~/.bashrc) is read as a download.
  const dlGroups = [];
  let closedDl = false; // the last ) closed a group with a download in it
  const fds = new Map(); // files exec opened by descriptor (exec 3>> ~/.bashrc)
  for (const seg of segs) {
    const sep = seg.sep;
    // Literal variables assigned earlier on the line are filled in (X=curl; $X url | sh).
    let words = applyVars(vars, seg.words, sep);
    if (vars.overflow) return OVERFLOW;
    if (sep === '(' && groups.length < MAX_SEGMENTS) groups.push(known);
    let readings = wordReadings(words, vars);
    if (readings === null) return OVERFLOW;
    for (const reading of readings) {
      const hit = checkSimple(reading, depth, known);
      if (hit) return hit;
    }
    // The group bookkeeping for downloads.
    let groupDl = closedDl;
    closedDl = false;
    if (words[0] === '{' && dlGroups.length < MAX_SEGMENTS) dlGroups.push(false);
    if (words[0] === '}' && dlGroups.length) groupDl = closeGroup(dlGroups) || groupDl;
    if (dlGroups.length && !dlGroups[dlGroups.length - 1] && runsDownload(readings[0])) dlGroups[dlGroups.length - 1] = true;
    if (words[0] === 'exec') recordFds(words, fds);
    if (groupDl) {
      // The command that receives the output of the group: read with a downloader in front of it.
      words = ['curl'].concat(words[0] === '}' ? words.slice(1) : words);
      readings = readings.map((r) => ['curl'].concat(r[0] === '}' ? r.slice(1) : r));
    }
    // A command substitution in backticks starts in the folder the line has reached, like $( ) and sh -c. While the folder is
    // still the one the line started in, the whole-line reading in analyze() has already covered it.
    if (seg.raw && known !== cwd0 && depth < MAX_DEPTH) {
      if (++ticks > MAX_TICK_READS) return OVERFLOW;
      const inner = backtickCode(seg.raw);
      const innerHit = inner ? analyze(inner, depth + 1, known) : null;
      if (innerHit) return innerHit;
    }
    if (sep !== '|' && sep !== '|&' && sep !== '&') {
      const to = cdTarget(unwrap(words), known);
      if (to === CWD_OVERFLOW) return OVERFLOW;
      if (to !== NOT_CD) known = to;
    }
    pipe.push({ words, sep });
    pipeReadings.push(readings);
    if (!isPipe(sep)) {
      const hit2 = checkPipelineReadings(pipe, pipeReadings, known, fds);
      if (hit2) return hit2;
      pipe = [];
      pipeReadings = [];
    }
    // A ( dropped after a pipe (curl URL | (sh)) opens a group of its own: save the folder so its ) pops that entry, not the enclosing one.
    for (let i = 0; i < (seg.opens || 0); i++) {
      if (groups.length < MAX_SEGMENTS) groups.push(known);
      if (dlGroups.length < MAX_SEGMENTS) dlGroups.push(false);
    }
    if (sep === '(' && dlGroups.length < MAX_SEGMENTS) dlGroups.push(false);
    if (sep === ')') {
      if (groups.length) known = groups.pop();
      if (dlGroups.length) closedDl = closeGroup(dlGroups);
    }
  }
  return pipe.length ? checkPipelineReadings(pipe, pipeReadings, known, fds) : null;
}

// The rules a second reading of the line (ANSI-C decoded, PowerShell script blocks) may report.
const NAMED_RULES = new Set(['pipe_to_shell', 'rc_download', 'rm_root_home', 'perm_root', 'disk_overwrite']);
const PS_BLOCK_RE = /(?:^|[\s;&|(=])\{\s*`?(?:remove-item|ri|rm|rd|rmdir|del|erase|iex|invoke-expression)\b/i;

/* The text with each { and } that is not part of a ${...} or @{...} written as a word of its own. */
function padScriptBlocks(text) {
  let out = '';
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const pad = !(i > 0 && (text[i - 1] === '$' || text[i - 1] === '@'));
      if (stack.length < MAX_SEGMENTS) stack.push(pad);
      out += pad ? ' { ' : ch;
    } else if (ch === '}') {
      out += (stack.length ? stack.pop() : true) ? ' } ' : ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function analyze(cmd, depth = 0, known = null) {
  const text = String(cmd);
  if (text.length > MAX_CHARS) return ENABLED === null || ENABLED.size > 0 ? OVERFLOW : null;
  // Text inside quotes is data (echo "a fork bomb is :(){ :|:& };:"); the code a shell runs from a string is checked
  // again on its own below, so the patterns that do not need the quotes read the text without them.
  // (Past QUOTE_SCAN_MAX the quotes are left in: finding every pair is the one step that is not linear.)
  // PowerShell runs a command named in quotes after & or . (& 'iex', . "irm"): such a name is kept, not blanked.
  const named = (text.includes("'") || text.includes('"')) && text.length <= QUOTE_SCAN_MAX ? text.replace(PS_QUOTED_NAME_RE, '$1$3') : text;
  const bare = text.length > QUOTE_SCAN_MAX ? text : named.replace(QUOTED_RE, "''");
  if ((FORK_BOMB_RE.test(bare)) && on('fork_bomb')) return 'fork_bomb';
  // PowerShell reading: a backtick and a line break continue the line, and so does a next line that starts with a pipe
  // (PowerShell 7), so `iwr URL` + newline + `| iex` is `iwr URL | iex`.
  const psBare = bare.includes('`') || bare.includes('\n')
    ? bare.replace(/`\r?\n/g, ' ').replace(PS_TICK_RE, '').replace(PS_NEXT_PIPE_RE, ' |')
    : bare;
  if ((SHELL_RUNS_DOWNLOAD_RE.test(text) || SOURCE_DOWNLOAD_RE.test(bare) || SHELL_STDIN_DOWNLOAD_RE.test(text) || PS_PIPE_RE.test(psBare) || PS_CALL_RE.test(psBare)) && on('pipe_to_shell')) return 'pipe_to_shell';
  if ((PS_DISK_RE.test(bare)) && on('disk_overwrite')) return 'disk_overwrite';
  const segs = segmentsOf(text);
  const hit = checkSegments(segs, depth, known);
  if (hit) return hit;
  // A command substitution in backticks runs its text as commands (echo `rm -rf ~`); read them like a sh -c string.
  if (depth < MAX_DEPTH && text.includes('`')) {
    const inner = backtickCode(text);
    const innerHit = inner ? analyze(inner, depth + 1, known) : null;
    if (innerHit) return innerHit;
  }
  // POSIX reading: an unquoted backslash escapes the next character and is removed (r\m, cu\rl, .bash\rc). The Windows
  // reading above keeps it as a path separator and runs first, so this one only adds blocks: any rule it hits counts.
  if (text.includes('\\')) {
    const posixHit = checkSegments(segmentsOf(text, true), depth, known);
    if (posixHit) return posixHit;
  }
  // ANSI-C quoting: bash reads $'\x63url' as curl. The words are decoded the way bash does, then read again; as above,
  // this reading only adds a block, and only for the rules that name a program, a file or a path ($'\x73h',
  // $'.bash\x72c', $'\x72m' -rf $'\x7e').
  if (text.includes("$'")) {
    const ansiHit = checkSegments(segmentsOf(policyModule()._decodeAnsiC(text), true), depth, known);
    if (NAMED_RULES.has(ansiHit)) return ansiHit;
  }
  // PowerShell script blocks: & {Remove-Item -Recurse C:\} runs the command inside the braces. The braces are read as
  // words of their own, only when one opens right before a delete command; as above, this reading only adds a block.
  if (text.includes('{') && PS_BLOCK_RE.test(text)) {
    const psHit = checkSegments(segmentsOf(padScriptBlocks(text)), depth, known);
    if (NAMED_RULES.has(psHit)) return psHit;
  }
  // Fail closed: never allow a line whose tail was not read.
  return segs.truncated && (ENABLED === null || ENABLED.size > 0) ? OVERFLOW : null;
}

/**
 * Check one shell command (Bash, sh, zsh or PowerShell text).
 * Returns the same shape as evaluate(): { verdict: 'allow' | 'block', confidence, rule, reason, engine, rules_version }.
 */
function checkCommand(command) {
  const hit = typeof command === 'string' ? analyze(command, 0) : null;
  if (!hit) return { verdict: 'allow', confidence: 1.0, rule: 'none', reason: null, engine: 'oss-local', rules_version: COMMAND_RULES_VERSION };
  return {
    verdict: 'block',
    confidence: 0.95,
    rule: 'destructive:' + hit,
    reason: 'Destructive command: ' + (REASONS[hit] || OVERFLOW_REASON),
    engine: 'oss-local',
    rules_version: COMMAND_RULES_VERSION,
  };
}

/** The deny message for the agent hooks, or null. */
function denial(command, rules) {
  if (typeof command !== 'string') return null;
  const saved = ENABLED;
  ENABLED = rules ? new Set(rules) : null;
  let hit;
  try { hit = analyze(command, 0); } finally { ENABLED = saved; }
  if (!hit) return null;
  return 'zn blocked this: ' + (REASONS[hit] || OVERFLOW_REASON) + ' (rule: destructive:' + hit + '). ' +
    'Ask the user to confirm before running this command. If they want it, they can run it in their own terminal; do not run it yourself.';
}

/** The rules the agent hooks apply when the user has not changed anything. The other four are opt-in. */
const DEFAULT_RULES = ['rm_root_home', 'disk_overwrite'];

module.exports = { checkCommand, denial, DEFAULT_RULES, COMMAND_RULES_VERSION, RULES: Object.keys(REASONS).map((k) => 'destructive:' + k) };
