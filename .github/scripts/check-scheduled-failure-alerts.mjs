#!/usr/bin/env node
// Fails when a workflow with a `schedule:` trigger does not open an issue for its failed scheduled runs. Such a
// workflow needs a final job named alert-on-scheduled-failure that runs when a job it needs failed or was
// cancelled, has issues: write only on that job, and uses no untrusted input.
//
//   node .github/scripts/check-scheduled-failure-alerts.mjs [workflow-dir]     default: .github/workflows
//
// The check reads the files line by line (like check-timeouts.mjs), so it needs no YAML library. A scheduled
// workflow that has no alert job yet is listed in PENDING_ALERT and reported, not failed; an entry in that list
// fails once the job is added or the workflow is gone, so the list can only shrink.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ALERT_JOB = 'alert-on-scheduled-failure';

// The only expressions the alert job may interpolate. Anything else (github.event.*, inputs.*, github.head_ref)
// comes from the outside world or is not needed.
export const TRUSTED_EXPRESSIONS = [
  'github.token',
  'github.repository',
  'github.server_url',
  'github.run_id',
  'github.event_name',
  'needs.*.result',
];

export const RUN_URL_VALUE = '${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}';

// Scheduled workflows that have no alert job yet. Keep this list short: add the job, then remove the entry.
export const PENDING_ALERT = [
  'action-selftest.yml',
  'agent-compat.yml',
  'audit.yml',
  'cache-cleanup.yml',
  'cargo-audit.yml',
  'codeql.yml',
  'dependency-review.yml',
  'examples-smoke.yml',
  'fuzz.yml',
  'hook-latency.yml',
  'leak-bench.yml',
  'nightly-next.yml',
  'node-macos.yml',
  'plugins.yml',
  'quick-checks.yml',
  'scorecard.yml',
  'unused-deps.yml',
];

const EXPR = /\$\{\{\s*(.*?)\s*\}\}/g;

const ALERT_CONDITION = "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')";

// The alert job's if: exactly one of these. The repository guard is optional; nothing else is accepted.
export const APPROVED_IF = [
  `always() && github.repository == 'usezn/zn' && github.event_name == 'schedule' && (${ALERT_CONDITION})`,
  `always() && github.event_name == 'schedule' && (${ALERT_CONDITION})`,
];

/* Collapses whitespace so that line breaks and spacing inside parentheses do not matter. */
export function normalizeIf(text) {
  return text.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
}

function unquote(v) {
  return v.replace(/^(["'])(.*)\1$/, '$2');
}

function stripComment(v) {
  return v.replace(/\s+#.*$/, '').trim();
}

/* Splits the file into its top-level sections: key -> { inline: text after the colon, lines: the lines below it }. */
function sectionsOf(lines) {
  const sections = {};
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
    if (m) {
      cur = m[1];
      sections[cur] = { inline: stripComment(m[2]), lines: [] };
      continue;
    }
    if (cur) sections[cur].lines.push(line);
  }
  return sections;
}

/*
 * Reads a permissions block: `permissions: {scope: value, ...}` (flow map), `permissions: <inline>` (kept as
 * __inline) or the entries indented two spaces under the header. Entries that cannot be read go to __unreadable.
 */
function permsOf(inline, body, headerIndent) {
  if (inline) {
    const flow = inline.match(/^\{(.*)\}$/);
    if (!flow) return { __inline: inline };
    const map = {};
    for (const part of flow[1].split(',')) {
      const text = part.trim();
      if (!text) continue;
      const m = text.match(/^([A-Za-z-]+):\s*(\S+)$/);
      if (m) map[m[1]] = unquote(m[2]);
      else map.__unreadable = text;
    }
    return map;
  }
  const map = {};
  const entry = new RegExp('^' + ' '.repeat(headerIndent + 2) + '([A-Za-z-]+):\\s*(\\S+)');
  const end = new RegExp('^ {0,' + headerIndent + '}\\S');
  for (const line of body) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(entry);
    if (m) map[m[1]] = unquote(m[2]);
    else if (end.test(line)) break;
  }
  return map;
}

function grantsWrite(perms) {
  return Object.entries(perms).some(([k, v]) => (k === '__inline' ? /write-all/.test(v) : v === 'write'));
}

/* Only block maps, flow maps and read-all are readable forms; anything else could hide a write scope. */
function permsForm(perms, where) {
  const out = [];
  if (perms.__inline !== undefined && perms.__inline !== 'read-all') {
    out.push(`${where} permissions use the form "${perms.__inline}"; use a block map, a {scope: value} map or read-all`);
  }
  if (perms.__unreadable) out.push(`${where} permissions entry "${perms.__unreadable}" cannot be read`);
  return out;
}

/* Reads the jobs of a workflow. A job written in flow style is kept with unreadable: true so it fails the check. */
function jobsOf(lines) {
  const jobs = [];
  let cur = null;
  for (const line of lines) {
    const block = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (block) {
      cur = { name: block[1], lines: [], unreadable: false };
      jobs.push(cur);
      continue;
    }
    if (/^ {2}[^\s#]/.test(line)) {
      cur = { name: line.trim().split(':')[0].slice(0, 60), lines: [], unreadable: true };
      jobs.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  for (const j of jobs) {
    const L = j.lines;
    const needsIdx = L.findIndex((l) => /^ {4}needs:/.test(l));
    j.needs = [];
    j.needsReadable = true;
    if (needsIdx >= 0) {
      const rest = stripComment(L[needsIdx].replace(/^ {4}needs:/, ''));
      if (rest.startsWith('[')) {
        const m = rest.match(/^\[(.*)\]$/);
        if (m) j.needs = m[1].split(',').map((s) => unquote(s.trim())).filter(Boolean);
        else j.needsReadable = false;
      } else if (rest) {
        j.needs = [unquote(rest)];
      } else {
        for (let i = needsIdx + 1; i < L.length && /^ {6}-\s/.test(L[i]); i++) {
          j.needs.push(unquote(stripComment(L[i].replace(/^ {6}-\s+/, ''))));
        }
        if (!j.needs.length) j.needsReadable = false;
      }
    }
    const ifIdx = L.findIndex((l) => /^ {4}if:/.test(l));
    const ifRest = ifIdx >= 0 ? stripComment(L[ifIdx].replace(/^ {4}if:/, '')) : '';
    j.ifValue = ifRest && !/^[|>]/.test(ifRest) ? unquote(ifRest) : null;
    const permIdx = L.findIndex((l) => /^ {4}permissions:/.test(l));
    j.perms = permIdx >= 0
      ? permsOf(stripComment(L[permIdx].replace(/^ {4}permissions:/, '')), L.slice(permIdx + 1), 4)
      : {};
  }
  return jobs;
}

/*
 * Returns { scheduled, hasAlert, problems } for one workflow file's text. A workflow without a schedule trigger is
 * not scheduled and has no problems. A scheduled workflow without the alert job has hasAlert false (the caller
 * decides whether that is pending or a failure) and no problems of its own.
 */
export function checkWorkflow(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const sec = sectionsOf(lines);
  const on = sec.on || { inline: '', lines: [] };
  const scheduled = /\bschedule\b/.test(on.inline) || on.lines.some((l) => /^ {2}schedule:/.test(l));
  if (!scheduled) return { scheduled: false, hasAlert: false, problems: [] };

  const problems = [];
  const topPerms = sec.permissions ? permsOf(sec.permissions.inline, sec.permissions.lines, 0) : {};
  if (grantsWrite(topPerms)) {
    problems.push('workflow-level permissions grant write; keep them read and give write to the alert job only');
  }
  problems.push(...permsForm(topPerms, 'workflow-level'));

  const jobs = jobsOf(sec.jobs ? sec.jobs.lines : []);
  const alert = jobs.find((j) => j.name === ALERT_JOB);
  if (!alert) return { scheduled: true, hasAlert: false, problems };

  for (const j of jobs) {
    if (j.unreadable) problems.push(`job "${j.name}" is not in block form, so its needs and permissions cannot be read`);
  }
  for (const j of jobs) {
    problems.push(...permsForm(j.perms, `job "${j.name}"`));
    if (j !== alert && j.perms.issues === 'write') {
      problems.push(`job "${j.name}" grants issues: write; only ${ALERT_JOB} may write issues`);
    }
  }
  if (alert.perms.issues !== 'write') problems.push(`${ALERT_JOB} needs issues: write`);

  // needs: every other job of the workflow must be listed, and nothing else.
  const others = jobs.filter((j) => j !== alert).map((j) => j.name);
  if (!alert.needsReadable) {
    problems.push('needs of the alert job cannot be read (use a flow list or one name per line)');
  } else {
    const missing = others.filter((n) => !alert.needs.includes(n));
    if (missing.length) problems.push(`needs does not list: ${missing.join(', ')}`);
    const unknown = alert.needs.filter((n) => !others.includes(n));
    if (unknown.length) problems.push(`needs lists a job that does not exist: ${unknown.join(', ')}`);
  }

  // if: must be one of the approved forms exactly (whitespace may vary). A fragment check is not enough: a
  // leading `false &&` or `true ||` keeps the fragments but changes whether the job runs.
  const cond = alert.ifValue === null ? null : normalizeIf(alert.ifValue);
  if (cond === null) {
    problems.push('if of the alert job cannot be read (write it on one line)');
  } else if (!APPROVED_IF.includes(cond)) {
    problems.push(`if of the alert job must be exactly one of the approved forms (whitespace may vary): ${APPROVED_IF.join(' | ')}`);
  }

  // Only trusted expressions in the alert job, and the run link built from the run context only.
  for (const m of alert.lines.join('\n').matchAll(EXPR)) {
    if (!TRUSTED_EXPRESSIONS.includes(m[1].trim())) {
      problems.push(`alert job interpolates \${{ ${m[1]} }}; it may only use ${TRUSTED_EXPRESSIONS.join(', ')}`);
    }
  }
  const runUrl = alert.lines.map((l) => l.trim()).find((l) => l.startsWith('RUN_URL:'));
  if (!runUrl || runUrl.slice('RUN_URL:'.length).trim() !== RUN_URL_VALUE) {
    problems.push('RUN_URL must be the run link built from github.server_url, github.repository and github.run_id');
  }

  return { scheduled: true, hasAlert: true, problems };
}

export function checkDir(dir, pending = PENDING_ALERT) {
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const result = { checked: files.length, scheduled: [], pending: [], problems: [], lacking: [], stale: [] };
  for (const f of files) {
    const r = checkWorkflow(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!r.scheduled) continue;
    result.scheduled.push(f);
    if (!r.hasAlert) {
      if (pending.includes(f)) result.pending.push(f);
      else result.lacking.push(f);
    } else if (pending.includes(f)) {
      result.stale.push(f);
    }
    for (const reason of r.problems) result.problems.push({ file: f, reason });
  }
  for (const f of pending) {
    if (!result.scheduled.includes(f) && !result.stale.includes(f)) result.stale.push(f);
  }
  return result;
}

function main(argv) {
  const dir = argv[0] || '.github/workflows';
  const r = checkDir(dir);
  for (const p of r.problems) console.error(`${dir}/${p.file}: ${p.reason}`);
  for (const f of r.lacking) {
    console.error(`${dir}/${f}: runs on a schedule but has no "${ALERT_JOB}" job (add it, or list the file in PENDING_ALERT until it is added)`);
  }
  for (const f of r.stale) {
    console.error(`${f}: listed in PENDING_ALERT but it has the job now or is not a scheduled workflow; remove the entry`);
  }
  if (r.problems.length || r.lacking.length || r.stale.length) {
    console.error('\nSee .github/scripts/check-scheduled-failure-alerts.mjs for the rules the alert job must follow.');
    return 1;
  }
  console.log(`scheduled failure alerts OK: ${r.scheduled.length} scheduled workflow(s) checked; pending: ${r.pending.join(', ') || 'none'}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error('check-scheduled-failure-alerts: ' + e.message); process.exitCode = 1; }
}
