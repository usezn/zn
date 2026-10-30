'use strict';

/**
 * Production data guard: asks before an agent runs a command that deletes a database, cloud storage or infrastructure,
 * or force-pushes to a protected branch.
 *
 * On by default in the agent hooks. Where the agent can ask (Claude Code), the user is asked; where it cannot (Codex
 * CLI and others), the call is blocked with the reason and the next step. The setting is `hooks.productionDataGuard`
 * ("ask", "deny" or "off") in ~/.zn/config.json.
 *
 * It reads the text of one command. It is a guardrail against a model's mistake, not a sandbox: it does not read a
 * script or a program the agent wrote and then runs, and it does not see a request sent to a cloud API with a token
 * that was found. Rules:
 *
 *   sql_drop                  DROP DATABASE / SCHEMA / TABLE or TRUNCATE sent through psql, mysql, mariadb, sqlite3,
 *                             sqlcmd, clickhouse-client, usql or mongosh (-c, -e, --eval, an argument, a here-document
 *                             or a here-string; mongosh dropDatabase() and collection drop())
 *   terraform_destroy         terraform / tofu / terragrunt destroy, and apply -destroy
 *   kubectl_delete_namespace  kubectl / oc delete namespace, and oc delete project
 *   kubectl_delete_all        kubectl / oc delete ... --all
 *   aws_s3_delete             aws s3 rm --recursive, aws s3 rb, aws s3 sync --delete, aws s3api delete-bucket and
 *                             delete-objects
 *   aws_rds_delete            aws rds delete-*
 *   gcloud_delete             gcloud projects | sql instances | sql databases | storage buckets | container clusters delete,
 *                             and gcloud storage rm -r / --recursive
 *   git_force_push_protected  git push --force, -f, --force-with-lease or +ref to main, master, release/* or the
 *                             repository's default branch
 *   git_delete_protected_branch  git push --delete, -d or :branch (an empty source) naming main, master, release/* or
 *                             the repository's default branch
 *
 * The command is split with the destructive-command module's reader, so quotes, `&&`, `;`, pipes, `sudo`, `env`,
 * `sh -c` code, subshells ( ... ), brace groups { ...; }, `xargs` and `watch` are understood. Every scan is linear in the size of the command.
 */

const fs = require('fs');
const path = require('path');

const PROD_GUARD_RULES_VERSION = '2026-10-30.5';

const RULES = {
  sql_drop: { what: 'DROP DATABASE, DROP TABLE or TRUNCATE sent to a database', effect: 'deletes a database, a table or all of its rows' },
  terraform_destroy: { what: 'terraform destroy (or apply -destroy)', effect: 'deletes every resource the configuration manages' },
  kubectl_delete_namespace: { what: 'kubectl delete namespace (or oc delete project)', effect: 'deletes the namespace and everything in it' },
  kubectl_delete_all: { what: 'kubectl delete --all', effect: 'deletes every object of that kind that the command selects' },
  aws_s3_delete: { what: 'a recursive or bucket-level delete in S3 (aws s3 rm --recursive, s3 rb, s3 sync --delete, s3api delete-bucket or delete-objects)', effect: 'deletes objects or a whole bucket' },
  aws_rds_delete: { what: 'aws rds delete-*', effect: 'deletes a database instance, cluster or snapshot' },
  gcloud_delete: { what: 'gcloud delete of a project, a Cloud SQL instance or database, a storage bucket (or a recursive storage rm) or a cluster', effect: 'deletes it and what it holds' },
  git_force_push_protected: { what: 'a force push to a protected branch', effect: 'rewrites shared history that other people rely on' },
  git_delete_protected_branch: { what: 'deleting a protected branch on a remote', effect: 'removes a shared branch that other people rely on' },
};

const MAX_DEPTH = 3;
const MAX_CHARS = 200 * 1024;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh', 'rbash']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);
// Programs that read SQL, and the options that carry it.
const SQL_FLAGS = {
  psql: ['-c', '--command'], usql: ['-c', '--command'],
  mysql: ['-e', '--execute'], mariadb: ['-e', '--execute'], mycli: ['-e', '--execute'],
  sqlcmd: ['-Q', '-q', '--query'], 'clickhouse-client': ['-q', '--query'], clickhouse: ['-q', '--query'],
  cockroach: ['-e', '--execute'], sqlite3: [], sqlite: [], pgcli: [],
};
const MONGO_HEADS = new Set(['mongosh', 'mongo']);
const AWS_VALUE_FLAGS = new Set(['--profile', '--region', '--endpoint-url', '--output', '--query', '--ca-bundle', '--cli-read-timeout', '--cli-connect-timeout', '--color', '--cli-binary-format']);
const KUBECTL_VALUE_FLAGS = new Set(['-n', '--namespace', '--context', '--cluster', '--user', '--kubeconfig', '-s', '--server', '--token', '--as', '--as-group', '--request-timeout']);
const GIT_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);
// xargs and watch run the command they are given. Options that take a value as the next word.
const XARGS_VALUE_FLAGS = new Set(['-I', '-n', '-P', '-d', '-E', '-L', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--process-slot-var']);
const WATCH_VALUE_FLAGS = new Set(['-n', '--interval']);
const GCLOUD_PATHS = [
  ['projects', 'delete'], ['sql', 'instances', 'delete'], ['sql', 'databases', 'delete'],
  ['storage', 'buckets', 'delete'], ['container', 'clusters', 'delete'],
];

function internals() {
  const d = require('./destructive');
  return d._internals;
}

/* ------------------------------ SQL and JavaScript text ------------------------------ */

/* The text without string literals and comments, so 'DROP TABLE' inside a string is data. One pass, linear.
   An unterminated quote is read as code, never as a string that hides the rest. */
function stripLiterals(s, js) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "'" || c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (js && s[j] === '\\') { j += 2; continue; }
        if (s[j] === c) {
          if (!js && s[j + 1] === c) { j += 2; continue; }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) { out += c; i++; continue; }
      out += ' ';
      i = j + 1;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2);
      out += ' ';
      i = e < 0 ? n : e + 2;
      continue;
    }
    if ((js && c === '/' && s[i + 1] === '/') || (!js && c === '-' && s[i + 1] === '-')) {
      const e = s.indexOf('\n', i);
      out += ' ';
      i = e < 0 ? n : e;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const SQL_DROP_RE = /^(?:drop\s+(?:database|schema|table)\b|truncate\s+(?!\()(?:table\s+)?\S)/i;

function sqlDrops(text) {
  if (!text) return false;
  const pieces = stripLiterals(String(text), false).split(/[;\n]/);
  for (const p of pieces) if (SQL_DROP_RE.test(p.trim())) return true;
  return false;
}

const MONGO_DROP_RE = /\b(?:dropDatabase|dropAllUsers|dropAllRoles)\s*\(|\.\s*drop\s*\(/;

function mongoDrops(text) {
  return Boolean(text) && MONGO_DROP_RE.test(stripLiterals(String(text), true));
}

/* The SQL (or JavaScript) text a program is given on its command line, from the options that carry it. */
function inlineTexts(head, rest) {
  const out = [];
  const flags = Object.prototype.hasOwnProperty.call(SQL_FLAGS, head) ? SQL_FLAGS[head] : [];
  const eval_ = MONGO_HEADS.has(head);
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w === '<<<') { if (i + 1 < rest.length) out.push(rest[i + 1]); continue; }
    if (w.startsWith('<<<')) { out.push(w.slice(3)); continue; }
    if (eval_) {
      if (w === '--eval') { if (i + 1 < rest.length) out.push(rest[i + 1]); } else if (w.startsWith('--eval=')) out.push(w.slice(7));
      continue;
    }
    for (const f of flags) {
      if (w === f) { if (i + 1 < rest.length) out.push(rest[i + 1]); } else if (f.startsWith('--')) { if (w.startsWith(f + '=')) out.push(w.slice(f.length + 1)); } else if (w.length > 2 && w.startsWith(f)) out.push(w.slice(2));
    }
    // A cluster of short flags that ends in the SQL flag: psql -Atc "...", mysql -Be "..."
    const letter = (flags.find((f) => f.length === 2) || '').slice(1);
    if (letter && /^-[A-Za-z]{2,}$/.test(w) && w.endsWith(letter) && i + 1 < rest.length) out.push(rest[i + 1]);
  }
  if (head === 'sqlite3' || head === 'sqlite') {
    const pos = rest.filter((w) => !w.startsWith('-') && !w.startsWith('<<'));
    for (const p of pos.slice(1)) out.push(p);
  }
  return out;
}

/* ------------------------------ here-documents ------------------------------ */

const HEREDOC_RE = /(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;

/* The command text without the bodies of its here-documents, and the bodies with the line that starts each:
   { code, docs: [{ line, body }] }. A here-document whose end line is never found is left in place. */
function splitHeredocs(text) {
  if (!text.includes('<<')) return { code: text, docs: [] };
  const lines = text.split('\n');
  const keep = [];
  const docs = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    keep.push(line);
    if (!line.includes('<<')) continue;
    HEREDOC_RE.lastIndex = 0;
    const marks = [];
    let m;
    while ((m = HEREDOC_RE.exec(line)) !== null) {
      marks.push({ dash: m[1] === '-', delim: m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]) });
      if (marks.length >= 8) break;
    }
    let at = i + 1;
    for (const mk of marks) {
      let end = -1;
      for (let j = at; j < lines.length; j++) {
        const l = lines[j].replace(/\r$/, '');
        if ((mk.dash ? l.replace(/^\t+/, '') : l) === mk.delim) { end = j; break; }
      }
      if (end < 0) break;
      docs.push({ line, body: lines.slice(at, end).join('\n') });
      at = end + 1;
    }
    if (docs.length && at > i + 1) i = at - 1;
  }
  return { code: keep.join('\n'), docs };
}

/* ------------------------------ the commands ------------------------------ */

const flagIs = (w, long) => w === long || w.startsWith(long + '=');

function gitDir(cwd) {
  let dir = path.resolve(cwd);
  for (let k = 0; k < 40; k++) {
    const g = path.join(dir, '.git');
    try {
      const st = fs.statSync(g);
      if (st.isDirectory()) return { git: g, common: g };
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8').slice(0, 1000));
        if (m) {
          const git = path.resolve(dir, m[1].trim());
          let common = git;
          try { common = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
          return { git, common };
        }
        return null;
      }
    } catch { /* keep looking upward */ }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/* The current branch and the remote's default branch, from the repository files; null when not known. */
function repoBranches(cwd, remote) {
  const out = { current: null, def: null };
  if (!cwd) return out;
  const g = gitDir(cwd);
  if (!g) return out;
  try {
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(fs.readFileSync(path.join(g.git, 'HEAD'), 'utf8').slice(0, 500));
    if (m) out.current = m[1];
  } catch { /* detached or unreadable */ }
  try {
    const rem = /^[A-Za-z0-9._-]+$/.test(remote || '') ? remote : 'origin';
    const m = new RegExp('^ref:\\s*refs/remotes/' + rem.replace(/\./g, '\\.') + '/(.+?)\\s*$', 'm')
      .exec(fs.readFileSync(path.join(g.common, 'refs', 'remotes', rem, 'HEAD'), 'utf8').slice(0, 500));
    if (m) out.def = m[1];
  } catch { /* no default recorded */ }
  return out;
}

function isProtected(branch, def) {
  return branch === 'main' || branch === 'master' || branch.startsWith('release/') || (Boolean(def) && branch === def);
}

function gitForcePush(rest, cwd) {
  let i = 0;
  let dirFlag = null;
  while (i < rest.length && rest[i].startsWith('-')) {
    const f = rest[i++];
    if (f === '-C' && i < rest.length) dirFlag = rest[i];
    if (GIT_VALUE_FLAGS.has(f)) i++;
  }
  if (rest[i] !== 'push') return null;
  const args = rest.slice(i + 1);
  let force = false;
  let all = false;
  let del = false;
  const pos = [];
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    if (w === '--') { pos.push(...args.slice(k + 1)); break; }
    if (w.startsWith('--')) {
      if (flagIs(w, '--force') || flagIs(w, '--force-with-lease') || flagIs(w, '--force-if-includes')) force = true;
      else if (flagIs(w, '--mirror')) { force = true; all = true; } // --mirror deletes and overwrites remote refs: as a force push
      else if (w === '--all') all = true;
      else if (w === '--delete') del = true;
      else if (PUSH_VALUE_FLAGS.has(w)) k++;
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      if (/^-[A-Za-z]+$/.test(w) && w.includes('f')) force = true;
      if (/^-[A-Za-z]+$/.test(w) && w.includes('d')) del = true;
      if (w === '-o') k++;
      continue;
    }
    pos.push(w);
  }
  const remote = pos[0];
  const refs = pos.slice(1);
  const plus = refs.some((r) => r.startsWith('+'));
  const where = dirFlag && cwd ? path.resolve(cwd, dirFlag) : cwd;
  const { current, def } = repoBranches(where, remote);
  // A delete: every ref after --delete / -d, or a ref with an empty source (":main", ":refs/heads/main"). "+:main" is read as a force push below.
  for (const r of refs) {
    let name = null;
    if (del) name = r.replace(/^\+/, '');
    else if (r.startsWith(':')) name = r.slice(1);
    if (name === null) continue;
    const colon = name.indexOf(':');
    if (colon >= 0) name = name.slice(colon + 1);
    name = name.replace(/^refs\/heads\//, '');
    if (name && isProtected(name, def)) return { branch: name, del: true };
  }
  if (!force && !plus) return null;
  const branches = [];
  if (all) return { branch: 'all branches' };
  if (!refs.length) { if (current) branches.push(current); }
  for (const r of refs) {
    if (!force && !r.startsWith('+')) continue;
    let ref = r.replace(/^\+/, '');
    const colon = ref.indexOf(':');
    if (colon >= 0) ref = ref.slice(colon + 1);
    if (ref === 'HEAD' || ref === '') { if (current) branches.push(current); continue; }
    branches.push(ref.replace(/^refs\/heads\//, ''));
  }
  for (const b of branches) if (isProtected(b, def)) return { branch: b };
  return null;
}

function kubectlDelete(head, rest) {
  let i = 0;
  while (i < rest.length && (rest[i].startsWith('-') || KUBECTL_VALUE_FLAGS.has(rest[i - 1]))) i++;
  if (rest[i] !== 'delete') return null;
  const args = rest.slice(i + 1);
  let k = 0;
  while (k < args.length && (args[k].startsWith('-') || KUBECTL_VALUE_FLAGS.has(args[k - 1]))) k++;
  const kind = (args[k] || '').toLowerCase();
  if (head === 'oc' && /^projects?(?:\/|$)/.test(kind)) return 'kubectl_delete_namespace';
  if (/^(?:namespaces?|ns)(?:\/|$)/.test(kind) || kind.split(',').some((x) => /^(?:namespaces?|ns)$/.test(x))) return 'kubectl_delete_namespace';
  if (args.some((w) => w === '--all' || w === '--all=true')) return 'kubectl_delete_all';
  return null;
}

function awsDelete(rest) {
  const pos = [];
  for (let i = 0; i < rest.length && pos.length < 2; i++) {
    const w = rest[i];
    if (w.startsWith('-')) { if (AWS_VALUE_FLAGS.has(w)) i++; continue; }
    pos.push(w);
  }
  const [service, op] = pos;
  if (service === 's3') {
    if (op === 'rb') return 'aws_s3_delete';
    if (op === 'rm' && rest.includes('--recursive') && !rest.includes('--dryrun')) return 'aws_s3_delete';
    if (op === 'sync' && rest.includes('--delete') && !rest.includes('--dryrun')) return 'aws_s3_delete';
  }
  if (service === 's3api' && (op === 'delete-bucket' || op === 'delete-objects')) return 'aws_s3_delete';
  if (service === 'rds' && typeof op === 'string' && op.startsWith('delete-')) return 'aws_rds_delete';
  return null;
}

function gcloudDelete(rest) {
  const pos = rest.filter((w) => !w.startsWith('-'));
  // gcloud storage rm of a whole tree (-r, -R, --recursive); no name check, like aws s3 rm --recursive.
  for (let i = 0; i + 1 < pos.length; i++) {
    if (pos[i] === 'storage' && pos[i + 1] === 'rm' && rest.some((w) => w === '-r' || w === '-R' || flagIs(w, '--recursive'))) return 'gcloud_delete';
  }
  for (const p of GCLOUD_PATHS) {
    for (let i = 0; i + p.length <= pos.length; i++) {
      if (p.every((x, k) => pos[i + k] === x)) return 'gcloud_delete';
    }
  }
  return null;
}

function terraformDestroy(head, rest) {
  const pos = rest.filter((w) => !w.startsWith('-'));
  if (pos[0] === 'destroy' || (head === 'terragrunt' && pos.includes('destroy'))) return 'terraform_destroy';
  const apply = pos[0] === 'apply' || (head === 'terragrunt' && pos.includes('apply'));
  if (apply && rest.some((w) => /^--?destroy(?:=(?:true|1))?$/.test(w))) return 'terraform_destroy';
  return null;
}

/* The command a simple command runs, once the words that only run it are taken off: the "{" that opens a brace group
   (a ( subshell is already a separate command), sudo, env and the like, and xargs / watch with their options. */
function commandArgs(words) {
  const { unwrap, programName } = internals();
  let w = words;
  let i = 0;
  while (i < w.length && w[i] === '{') i++;
  w = unwrap(w.slice(i));
  for (let round = 0; round < 3 && w.length; round++) {
    const name = programName(w[0]);
    const valueFlags = name === 'xargs' ? XARGS_VALUE_FLAGS : (name === 'watch' ? WATCH_VALUE_FLAGS : null);
    if (!valueFlags) break;
    let k = 1;
    while (k < w.length && w[k].startsWith('-') && w[k] !== '-') {
      const f = w[k++];
      if (f === '--') break;
      if (valueFlags.has(f)) k++;
    }
    w = unwrap(w.slice(k));
  }
  return w;
}

function checkSimple(words, depth, ctx, docs, pipeText) {
  const { programName } = internals();
  const args = commandArgs(words);
  if (!args.length) return null;
  const head = programName(args[0]);
  const rest = args.slice(1);

  // Shell code inside the command: sh -c "...", eval "...", pwsh -Command "...", cmd /c "..."
  let code = null;
  if (SHELLS.has(head) || head === 'su') {
    const k = rest.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
    if (k >= 0 && k + 1 < rest.length) code = rest[k + 1];
  } else if (head === 'eval') {
    code = rest.join(' ');
  } else if (POWERSHELLS.has(head)) {
    const k = rest.findIndex((w) => /^-c(?:ommand)?$/i.test(w));
    if (k >= 0) code = rest.slice(k + 1).join(' ');
  } else if (head === 'cmd') {
    const k = rest.findIndex((w) => /^\/[ck]$/i.test(w));
    if (k >= 0) code = rest.slice(k + 1).join(' ');
  }
  if (code !== null && depth < MAX_DEPTH) {
    const hit = analyze(code, depth + 1, ctx);
    if (hit) return hit;
  }
  // A shell that reads its script from a here-document: bash <<EOF ... EOF
  if (SHELLS.has(head) && code === null && docs.length && depth < MAX_DEPTH) {
    for (const d of docs) {
      const hit = analyze(d.body, depth + 1, ctx);
      if (hit) return hit;
    }
  }

  if (Object.prototype.hasOwnProperty.call(SQL_FLAGS, head) || MONGO_HEADS.has(head)) {
    const check = MONGO_HEADS.has(head) ? mongoDrops : sqlDrops;
    if (inlineTexts(head, rest).some(check)) return { rule: 'sql_drop' };
    for (const d of docs) if (check(d.body)) return { rule: 'sql_drop' };
    if (pipeText && pipeText.some(check)) return { rule: 'sql_drop' };
    return null;
  }
  if (head === 'terraform' || head === 'tofu' || head === 'terragrunt') {
    const r = terraformDestroy(head, rest);
    return r ? { rule: r } : null;
  }
  if (head === 'kubectl' || head === 'oc') {
    const r = kubectlDelete(head, rest);
    return r ? { rule: r } : null;
  }
  if (head === 'aws') {
    const r = awsDelete(rest);
    return r ? { rule: r } : null;
  }
  if (head === 'gcloud') {
    const r = gcloudDelete(rest);
    return r ? { rule: r } : null;
  }
  if (head === 'git') {
    const r = gitForcePush(rest, ctx.cwd);
    return r ? { rule: r.del ? 'git_delete_protected_branch' : 'git_force_push_protected', detail: r.branch } : null;
  }
  return null;
}

const ECHO_HEADS = new Set(['echo', 'printf']);

const isDocWord = (w) => w.startsWith('<<') && !w.startsWith('<<<');

/* A here-document goes to the commands that open one (the docs of different lines are not told apart). */
function checkSegments(segs, depth, ctx, docs) {
  const { programName } = internals();
  let pipeText = [];
  for (const seg of segs) {
    const segDocs = seg.words.some(isDocWord) ? docs : [];
    const hit = checkSimple(seg.words, depth, ctx, segDocs, pipeText);
    if (hit) return hit;
    const args = commandArgs(seg.words);
    const head = args.length ? programName(args[0]) : '';
    if (ECHO_HEADS.has(head)) pipeText.push(args.slice(1).join(' '));
    if (head === 'cat') for (const d of segDocs) pipeText.push(d.body);
    if (seg.sep !== '|' && seg.sep !== '|&') pipeText = [];
  }
  return null;
}

function analyze(cmd, depth, ctx) {
  const text = String(cmd);
  if (text.length > MAX_CHARS) return null;
  const { segmentsOf } = internals();
  const { code, docs } = splitHeredocs(text);
  const attach = (segs) => checkSegments(segs, depth, ctx, docs);
  const segs = segmentsOf(code);
  const hit = attach(segs);
  if (hit) return hit;
  if (code.includes('\\')) {
    const h2 = attach(segmentsOf(code, true));
    if (h2) return h2;
  }
  if (code.includes("$'")) {
    const h3 = attach(segmentsOf(require('./hooks/policy')._decodeAnsiC(code), true));
    if (h3) return h3;
  }
  return null;
}

/**
 * Check one shell command. Returns null, or { rule, id, what, effect, message, deny }:
 *   rule     the rule name (sql_drop, terraform_destroy ...), id = 'prod:' + rule
 *   message  the question for an agent that can ask
 *   deny     the text for a block (strict mode, or an agent that cannot ask)
 * opts.cwd is the folder the command runs in; it is used only to read the current and default branch of a git push
 * that names no branch.
 */
function checkProductionData(command, opts = {}) {
  if (typeof command !== 'string' || !command) return null;
  const hit = analyze(command, 0, { cwd: opts.cwd || null });
  if (!hit) return null;
  const r = RULES[hit.rule];
  const what = hit.detail ? r.what.replace('a protected branch', hit.detail === 'all branches' ? 'all branches, protected ones included' : 'the protected branch ' + hit.detail) : r.what;
  return {
    rule: hit.rule,
    id: 'prod:' + hit.rule,
    what,
    effect: r.effect,
    message: 'zn: this command is ' + what + ', which ' + r.effect + '. Approve only if the user asked for exactly this and the target is not production data; otherwise check first with a read-only command.',
    deny: 'zn blocked this: it is ' + what + ', which ' + r.effect + '. Next step: ask the user to confirm. If they want it, they can run it in their own terminal; do not run it yourself.',
  };
}

module.exports = { checkProductionData, PROD_GUARD_RULES_VERSION, RULES: Object.keys(RULES).map((k) => 'prod:' + k) };
