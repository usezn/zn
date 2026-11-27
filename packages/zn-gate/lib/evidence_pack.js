'use strict';

// The evidence pack for auditors: a folder with the records of a date range, the result of checking
// the whole hash chain, a summary, a control map in plain English, a manifest with the hash of each
// file, and a README. Nothing is uploaded; the folder is written to disk.
//
// The log is copied once to a private temporary file (up to the size seen when it was opened), and
// both passes read that copy: one to check the whole chain (streamed, as the export does), one to
// pick the records of the range. So chain.json always describes the bytes the records come from,
// even if the log changes while the pack is made. Records are written in log order.
// A record with no valid UTC time is counted as undated; it is left out when a date range is given
// and kept otherwise. Without --include-preview the payload_preview field is removed from each
// record (the other fields are written as JSON, in the same order). With it, the records are the
// log lines as they are, the same bytes that the jsonl export writes for them.
// The Python package (zn_gate/evidence_pack.py) writes the same bytes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { timesketchMicros, ocsfEvent } = require('./evidence_export');

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const NEWLINE = Buffer.from('\n');
const READ_CHUNK = 256 * 1024;

// The formats of the records file. Each one turns one log line into the bytes written for it, so a
// new format (OCSF, later) is one more entry here.
// objectsOnly: the format writes JSON objects only (as the export does for OCSF); other lines are left out.
// line(raw, rec, ctx): rec is the parsed record when the line is a JSON object, else undefined;
// ctx = { includePreview, index (chain index), verified (the chain verified up to this record) }.
const PACK_FORMATS = {
  jsonl: {
    recordsFile: 'records.jsonl',
    objectsOnly: false,
    line(raw, rec, ctx) {
      if (ctx.includePreview || rec === undefined || !Object.prototype.hasOwnProperty.call(rec, 'payload_preview')) {
        return Buffer.concat([raw, NEWLINE]);
      }
      const { payload_preview: _removed, ...rest } = rec;
      return Buffer.from(JSON.stringify(rest) + '\n', 'utf8');
    },
  },
  ocsf: {
    recordsFile: 'records.ocsf.jsonl',
    objectsOnly: true,
    // The same OCSF event the ocsf export writes for the record (preview only with includePreview).
    line(raw, rec, ctx) {
      return Buffer.from(JSON.stringify(ocsfEvent(rec, ctx.index, ctx.verified, ctx.includePreview)) + '\n', 'utf8');
    },
  },
};
const PACK_FILES = ['records.jsonl', 'chain.json', 'summary.json', 'controls.md', 'README.txt'];

const CONTROLS_TEXT = `# Control map

This map shows which records in this pack may help as evidence for these criteria. zn-gate does not make a system compliant, and this pack is not an attestation. Your auditor decides what evidence is sufficient.

Each entry gives a plain-English reading of one criterion, the records in this pack that may support it, and the fields to look at. Field names are the ones in records.jsonl. In records.ocsf.jsonl the same values sit under OCSF names, and the zn-gate fields under unmapped. The verdict is "allow" or "block".

## CC6.1 Logical access

The criterion is about limiting access to systems and data to the people and programs that need it, and checking that access.

Records that may help: records with verdict "block" show actions that zn-gate stopped. Records with verdict "allow" show actions it let through.

Where to look: verdict, agent_environment (which agent ran), tool_name (what it tried to do), rule (the rule that decided).

## CC6.6 Threats from outside the system boundary

The criterion is about protecting the system against threats that come from outside its boundary, such as untrusted content or outside connections.

Records that may help: records with a rule or a reason that concerns outside content, tool results or network use. The summary counts rule ids in summary.json.

Where to look: rule, reason, phase (the point at which the check ran), verdict.

## CC7.2 Monitoring for anomalies

The criterion is about monitoring the system for unusual activity and reviewing what the monitoring finds.

Records that may help: the block records over time, and the counts by rule in summary.json. chain.json shows whether the whole log checked out when the pack was made.

Where to look: timestamp, verdict, rule, agent_environment; chain.json fields verified and break_index.

## CC8.1 Change management

The criterion is about making changes to software, data and configuration through a controlled and authorized process.

Records that may help: records of tool calls that write or change files, settings or other systems, with the verdict that zn-gate gave them. payload_sha256 links a record to the content it checked, without storing that content.

Where to look: tool_name, verdict, rule, payload_sha256.
`;

const README_TEXT = `zn-gate evidence pack
=====================

This folder holds the zn-gate records for one period, the result of checking the whole log, a summary, and a map of records that may help with a few audit criteria.

Files
- records.jsonl   the records in the period, one per line, in log order (with --format ocsf: records.ocsf.jsonl, the same records as OCSF events)
- chain.json      the result of checking the hash chain of the whole log, and the first and last record of the period
- summary.json    counts by verdict, agent and rule for the records in this folder
- controls.md     which records may help as evidence for four criteria, and where to look
- manifest.json   the sha256 and size of each file above (written last; if it is missing, the pack is incomplete)
- README.txt      this file

How to check the pack
1. Compute the sha256 of each file and compare it with manifest.json.
   Linux or macOS:  sha256sum records.jsonl chain.json summary.json controls.md README.txt
   Windows:         Get-FileHash -Algorithm SHA256 records.jsonl
2. Run "zn-gate evidence --verify" on the original log. This checks the hash chain again. The check covers the whole log, not only the period in this folder.
3. Open chain.json. "verified": true means the whole log checked out when the pack was made.

Notes
- Without --include-preview, the payload_preview field is removed from each record. Its hash is not in the pack, so re-checking the hashes needs the original log.
- A pack is a copy of records. It is not an attestation.
`;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** A YYYY-MM-DD calendar date that exists, or null. */
function parseDay(text) {
  const m = typeof text === 'string' ? DATE_RE.exec(text) : null;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  const days = mo === 2 && isLeapYear(y) ? 29 : MONTH_DAYS[mo - 1];
  if (d < 1 || d > days) return null;
  return text;
}

/**
 * Checks the options of a pack. Returns { since, until, format } (null for a missing date) or
 * { error } with a one-line message for the user.
 */
function validatePackOptions(opts = {}) {
  const format = (opts.format || 'jsonl').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(PACK_FORMATS, format)) {
    return { error: `zn-gate: evidence pack supports --format jsonl or ocsf (got "${String(opts.format).replace(/[^\x20-\x7e]/g, '?').slice(0, 40)}").` };
  }
  let since = null;
  let until = null;
  if (opts.since !== undefined && opts.since !== null) {
    since = parseDay(opts.since);
    if (since === null) return { error: `zn-gate: --since must be a real date in the form YYYY-MM-DD (got "${String(opts.since).slice(0, 40)}").` };
  }
  if (opts.until !== undefined && opts.until !== null) {
    until = parseDay(opts.until);
    if (until === null) return { error: `zn-gate: --until must be a real date in the form YYYY-MM-DD (got "${String(opts.until).slice(0, 40)}").` };
  }
  if (since !== null && until !== null && since > until) {
    return { error: 'zn-gate: --since is after --until, so the period is empty.' };
  }
  return { since, until, format };
}

/**
 * Null when outDir can be used for a new pack (missing, or an empty folder); else a one-line reason.
 * A pack is never written over existing files.
 */
function packTargetProblem(outDir) {
  let st;
  try {
    st = fs.statSync(outDir);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return `zn-gate: cannot use ${outDir}: ${e.code || e.message}.`;
  }
  if (!st.isDirectory()) return `zn-gate: ${outDir} exists and is not a folder.`;
  if (fs.readdirSync(outDir).length > 0) return `zn-gate: ${outDir} is not empty; choose a new folder.`;
  return null;
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Object with keys in sorted order (counts are written in a fixed order).
function sortedCounts(counts) {
  const out = {};
  for (const k of Object.keys(counts).sort()) out[k] = counts[k];
  return out;
}

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

/**
 * Calls onLine(bytes) for each line of the first `size` bytes of the file, without its newline.
 * Throws the given error class when the file cannot be read in full.
 */
function forEachLine(filePath, size, EvidenceLedgerError, onLine) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    throw new EvidenceLedgerError(`Cannot read the evidence log: ${e.code || e.message}`);
  }
  try {
    const buf = Buffer.alloc(Math.max(1, Math.min(READ_CHUNK, size)));
    let pos = 0;
    let carry = [];
    while (pos < size) {
      let n;
      try {
        n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
      } catch (e) {
        throw new EvidenceLedgerError(`Cannot read the evidence log: ${e.code || e.message}`);
      }
      if (n === 0) throw new EvidenceLedgerError('Cannot read the evidence log: the log got shorter while it was read');
      const chunk = buf.subarray(0, n);
      pos += n;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(0x0a, start);
        if (nl === -1) break;
        if (carry.length) {
          carry.push(chunk.subarray(start, nl));
          onLine(Buffer.concat(carry));
          carry = [];
        } else {
          onLine(chunk.subarray(start, nl));
        }
        start = nl + 1;
      }
      if (start < n) carry.push(Buffer.from(chunk.subarray(start, n)));
    }
    if (carry.length) onLine(Buffer.concat(carry));
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Copies the first `size` bytes of the log, as seen on one open file, to a private temporary file.
 * Returns { path, cleanup }, or null when the log does not exist.
 */
function snapshotLog(filePath, EvidenceLedgerError) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new EvidenceLedgerError(`Cannot read the evidence log: ${e.code || e.message}`);
  }
  let dir = null;
  const cleanup = () => { if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-pack-'));
    const copy = path.join(dir, 'evidence.jsonl');
    const out = fs.openSync(copy, 'wx', 0o600);
    try {
      let size;
      try {
        size = fs.fstatSync(fd).size;
      } catch (e) {
        throw new EvidenceLedgerError(`Cannot read the evidence log: ${e.code || e.message}`);
      }
      const buf = Buffer.alloc(Math.max(1, Math.min(READ_CHUNK, size)));
      let pos = 0;
      while (pos < size) {
        let n;
        try {
          n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
        } catch (e) {
          throw new EvidenceLedgerError(`Cannot read the evidence log: ${e.code || e.message}`);
        }
        if (n === 0) throw new EvidenceLedgerError('Cannot read the evidence log: the log got shorter while it was read');
        fs.writeSync(out, buf, 0, n);
        pos += n;
      }
    } finally {
      try { fs.closeSync(out); } catch { /* ignore */ }
    }
    return { path: copy, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Writes the pack into outDir (which must be missing or empty; see packTargetProblem).
 * deps: { exporter, EvidenceLedgerError, trimBytes }. opts: { since, until, format, includePreview,
 * generator, now (Date, for tests) }. Resolves with { valid, total, records, undated, files }.
 * Read errors throw EvidenceLedgerError; a chain that does not verify is reported, not thrown: the
 * pack is still written, with chain.json saying so.
 */
function writeEvidencePack(filePath, outDir, opts, deps) {
  const snap = snapshotLog(filePath, deps.EvidenceLedgerError);
  try {
    return writePackFromSnapshot(snap ? snap.path : filePath, outDir, opts, deps);
  } finally {
    if (snap) snap.cleanup();
  }
}

function writePackFromSnapshot(filePath, outDir, opts, deps) {
  const { exporter, EvidenceLedgerError, trimBytes } = deps;
  const req = validatePackOptions(opts);
  if (req.error) throw new Error(req.error);
  const format = PACK_FORMATS[req.format];
  const includePreview = !!opts.includePreview;
  const hasRange = req.since !== null || req.until !== null;

  // Pass 1: the chain check of the whole snapshot.
  const check = {};
  for (const piece of exporter.exportChunks(filePath, 'none', check)) void piece;
  const res = check.result;
  const size = res.bytes;

  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, buf) => {
    const p = path.join(outDir, name);
    fs.writeFileSync(p, buf, { flag: 'wx' });
    return { sha256: sha256Hex(buf), bytes: buf.length };
  };

  // Pass 2: the records of the period, in log order.
  const recordsPath = path.join(outDir, format.recordsFile);
  const recordsFd = fs.openSync(recordsPath, 'wx');
  const recordsHash = crypto.createHash('sha256');
  let recordsBytes = 0;
  let chainIndex = 0;
  let undated = 0;
  let included = 0;
  let rangeFirst = null;
  let rangeLast = null;
  let firstTs = null;
  let lastTs = null;
  const verdicts = {};
  const agents = {};
  const rules = {};
  const writeRecord = (buf) => {
    fs.writeSync(recordsFd, buf);
    recordsHash.update(buf);
    recordsBytes += buf.length;
  };
  try {
    if (fs.existsSync(filePath) && size > 0) {
      forEachLine(filePath, size, EvidenceLedgerError, (raw) => {
        const b = trimBytes(raw);
        if (b.length === 0) return;
        const index = chainIndex++;
        let rec;
        try {
          rec = JSON.parse(STRICT_UTF8.decode(b));
        } catch {
          rec = undefined;
        }
        const isObj = rec !== null && typeof rec === 'object' && !Array.isArray(rec);
        const ts = isObj && typeof rec.timestamp === 'string' && timesketchMicros(rec.timestamp) !== '' ? rec.timestamp : null;
        let keep;
        if (ts === null) {
          undated++;
          keep = !hasRange;
        } else {
          const day = ts.slice(0, 10);
          keep = (req.since === null || day >= req.since) && (req.until === null || day <= req.until);
        }
        if (!keep) return;
        if (format.objectsOnly && !isObj) return;
        // A record is verified when the chain verified up to it: every record before the first break.
        const verified = res.valid === true || index < res.broken_index;
        writeRecord(format.line(raw, isObj ? rec : undefined, { includePreview, index, verified }));
        included++;
        if (ts !== null) {
          if (firstTs === null) firstTs = ts;
          lastTs = ts;
        }
        if (isObj) {
          if (typeof rec.verdict === 'string') bump(verdicts, rec.verdict);
          if (typeof rec.agent_environment === 'string') bump(agents, rec.agent_environment);
          if (typeof rec.rule === 'string' && rec.rule !== '') bump(rules, rec.rule);
          if (typeof rec.record_hash === 'string') {
            const entry = { chain_index: index, record_hash: rec.record_hash };
            if (rangeFirst === null) rangeFirst = entry;
            rangeLast = entry;
          }
        }
      });
    }
  } finally {
    fs.closeSync(recordsFd);
  }
  const recordsFile = { sha256: recordsHash.digest('hex'), bytes: recordsBytes };

  const chain = {
    records: res.total,
    verified: res.valid === true,
    break_index: res.valid ? null : (res.broken_index ?? null),
    error: res.valid ? null : (res.error ?? null),
    truncated_tail: res.truncated_tail === true,
    tip_record_hash: res.tip_record_hash ?? null,
    range_records: included,
    range_first: rangeFirst,
    range_last: rangeLast,
  };
  const summary = {
    generator: opts.generator,
    period: { since: req.since, until: req.until },
    records: included,
    undated,
    undated_included: !hasRange,
    first_timestamp: firstTs,
    last_timestamp: lastTs,
    verdicts: sortedCounts(verdicts),
    agents: sortedCounts(agents),
    rules: sortedCounts(rules),
  };

  const files = {
    [format.recordsFile]: recordsFile,
    'chain.json': write('chain.json', Buffer.from(JSON.stringify(chain) + '\n', 'utf8')),
    'summary.json': write('summary.json', Buffer.from(JSON.stringify(summary) + '\n', 'utf8')),
    'controls.md': write('controls.md', Buffer.from(CONTROLS_TEXT, 'utf8')),
    'README.txt': write('README.txt', Buffer.from(README_TEXT, 'utf8')),
  };
  const now = opts.now instanceof Date ? opts.now : new Date();
  const manifest = {
    generator: opts.generator,
    pack_time_utc: now.toISOString().slice(0, 19) + 'Z',
    files,
  };
  // Written last: its presence means every file above was written.
  write('manifest.json', Buffer.from(JSON.stringify(manifest) + '\n', 'utf8'));

  return { valid: res.valid === true, total: res.total, records: included, undated, files, error: chain.error };
}

module.exports = { writeEvidencePack, validatePackOptions, packTargetProblem, PACK_FILES, PACK_FORMATS };
