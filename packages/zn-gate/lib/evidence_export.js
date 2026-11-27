'use strict';

// Streams the evidence log into a jsonl, csv or Timesketch export while it checks the hash chain, so a log of
// any size is exported in bounded memory. The log is read in chunks up to the size it had when the
// export started (records appended meanwhile wait for the next export). The chain check gives the
// same result, with the same messages, as verifyEvidenceLedger, and any read error stops the export
// with an EvidenceLedgerError: an export is never reported complete when part of the log was not read.

const fs = require('fs');

const DEFAULT_CHUNK = 256 * 1024;
// CSV rows are handed out in batches of about this many characters.
const CSV_BATCH = 256 * 1024;

const CSV_HEADERS = [
  'timestamp',
  'verdict',
  'phase',
  'tool_name',
  'agent_environment',
  'rule',
  'reason',
  'payload_sha256',
  'record_hash',
  'prev_hash',
  'latency_us',
];
const CSV_HEADER_LINE = CSV_HEADERS.join(',');

function csvRow(obj) {
  return CSV_HEADERS.map((h) => {
    const val = obj[h] !== undefined && obj[h] !== null ? String(obj[h]) : '';
    return `"${val.replace(/"/g, '""')}"`;
  }).join(',');
}

// Timesketch exports ('timesketch' = JSON Lines, 'timesketch-csv'). Timesketch needs message,
// datetime and timestamp_desc on every event (CSV also takes timestamp in microseconds); every
// other key becomes a searchable attribute. The message is built only from the verdict, tool,
// agent and rule id, and payload_preview (text the agent wrote) is never exported here.
const TIMESKETCH_FORMATS = new Set(['timesketch', 'timesketch-csv']);
const TIMESKETCH_DESC = 'zn-gate hook decision';
const TIMESKETCH_DATA_TYPE = 'zn:gate:decision';
const TIMESKETCH_RECORD_FIELDS = [
  ['zn_id', 'id'],
  ['zn_agent', 'agent_environment'],
  ['zn_phase', 'phase'],
  ['zn_tool', 'tool_name'],
  ['zn_verdict', 'verdict'],
  ['zn_rule', 'rule'],
  ['zn_reason', 'reason'],
  ['zn_confidence', 'confidence'],
  ['zn_engine', 'engine'],
  ['zn_latency_us', 'latency_us'],
  ['zn_payload_sha256', 'payload_sha256'],
  ['zn_record_hash', 'record_hash'],
  ['zn_prev_hash', 'prev_hash'],
];
const TIMESKETCH_CSV_HEADERS = [
  'message', 'datetime', 'timestamp', 'timestamp_desc', 'data_type',
  ...TIMESKETCH_RECORD_FIELDS.map(([k]) => k),
  'zn_chain_index', 'zn_chain_verified',
];
const TIMESKETCH_CSV_HEADER_LINE = TIMESKETCH_CSV_HEADERS.join(',');
const UTC_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days from 1970-01-01 to a proleptic Gregorian date (integer arithmetic, any 4-digit year). */
function daysFromCivil(y, mo, d) {
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * A UTC ISO 8601 time (the form the hook writes) as integer microseconds since the epoch, else ''.
 * The date must exist (no 30 February, no hour 24, no leap second); years 0000-0099 stay as written.
 */
function timesketchMicros(ts) {
  const m = typeof ts === 'string' ? UTC_ISO_RE.exec(ts) : null;
  if (!m) return '';
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i]));
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59) return '';
  const monthDays = mo === 2 && isLeapYear(y) ? 29 : MONTH_DAYS[mo - 1];
  if (d < 1 || d > monthDays) return '';
  const secs = BigInt(daysFromCivil(y, mo, d)) * 86400n + BigInt(h * 3600 + mi * 60 + s);
  const frac = m[7] ? BigInt(m[7].padEnd(6, '0')) : 0n;
  return (secs * 1000000n + frac).toString();
}

const plainText = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function timesketchEvent(rec, index, verified) {
  const rule = plainText(rec.rule);
  const ev = {
    message: `${plainText(rec.verdict)} ${plainText(rec.tool_name)} by ${plainText(rec.agent_environment)}` + (rule ? ` (rule ${rule})` : ''),
    datetime: plainText(rec.timestamp),
    timestamp_desc: TIMESKETCH_DESC,
    data_type: TIMESKETCH_DATA_TYPE,
  };
  for (const [key, field] of TIMESKETCH_RECORD_FIELDS) ev[key] = rec[field] === undefined ? null : rec[field];
  ev.zn_chain_index = index;
  ev.zn_chain_verified = verified;
  return ev;
}

function timesketchLine(format, rec, index, verified) {
  const ev = timesketchEvent(rec, index, verified);
  if (format === 'timesketch') return JSON.stringify(ev);
  return TIMESKETCH_CSV_HEADERS.map((h) => {
    const val = h === 'timestamp' ? timesketchMicros(rec.timestamp) : plainText(ev[h]);
    return `"${val.replace(/"/g, '""')}"`;
  }).join(',');
}

/**
 * deps: { trimBytes, canonicalForms, genesisHash, recordStart, truncatedTailResult,
 *         EvidenceLedgerError, testHooks }
 */
function createExporter(deps) {
  const { trimBytes, canonicalForms, genesisHash, recordStart, truncatedTailResult, EvidenceLedgerError, testHooks } = deps;
  const crypto = require('crypto');

  const readError = (e) => (e instanceof EvidenceLedgerError
    ? e
    : new EvidenceLedgerError(`Cannot read the evidence log: ${(e && (e.code || e.message)) || e}`));

  // The chain check, one line at a time. A line is checked once the next non-empty line (or the
  // end of the file) is known, because a malformed last line can be a cut-off write.
  function createChecker(endsWithNewline) {
    let expectedPrevHash = genesisHash;
    let failure = null;
    let index = 0;
    function check(text, rec, parseError, badUtf8, isLast) {
      const i = index++;
      if (failure) return;
      if (badUtf8) {
        failure = { verified: i, broken_index: i, error: `Invalid UTF-8 bytes at line ${i + 1}: the log was corrupted or modified.` };
        return;
      }
      if (parseError) {
        if (isLast && text.startsWith(recordStart) && !endsWithNewline()) {
          failure = { truncated: i };
          return;
        }
        failure = { verified: i, broken_index: i, error: `Malformed JSON at line ${i + 1}: ${parseError.message}` };
        return;
      }
      if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        failure = { verified: i, broken_index: i, error: `Malformed record at line ${i + 1}: not a JSON object.` };
        return;
      }
      if (rec.prev_hash !== expectedPrevHash) {
        failure = {
          verified: i,
          broken_index: i,
          error: `Broken chain link at line ${i + 1} (record ${rec.id}): expected prev_hash ${expectedPrevHash.slice(0, 8)}... but found ${rec.prev_hash?.slice(0, 8)}...`,
        };
        return;
      }
      const { record_hash, ...baseRecord } = rec;
      const hashOf = (t) => crypto.createHash('sha256').update(expectedPrevHash + ':' + t).digest('hex');
      if (!canonicalForms(baseRecord).some((t) => hashOf(t) === record_hash)) {
        failure = {
          verified: i,
          broken_index: i,
          error: `Tamper detected at line ${i + 1} (record ${rec.id}): hash mismatch. The content of this log was altered!`,
        };
        return;
      }
      expectedPrevHash = record_hash;
    }
    // True while every line checked so far verified.
    const ok = () => failure === null;
    function result(total) {
      if (!failure) return { valid: true, total, verified: total, broken_index: null, error: null };
      if (failure.truncated !== undefined) return truncatedTailResult(total, failure.truncated);
      return { valid: false, total, verified: failure.verified, broken_index: failure.broken_index, error: failure.error };
    }
    return { check, result, ok };
  }

  /**
   * Yields the export text in pieces. format: 'jsonl', 'csv', 'timesketch', 'timesketch-csv' or
   * 'none' (check only). Timesketch events carry the chain check per record. When the
   * generator finishes, state.result holds { format, valid, total, verified, broken_index, error,
   * tip_hash, truncated_tail?, bytes }. opts.size limits the read to that many bytes (a size found
   * by an earlier pass). Throws EvidenceLedgerError when the log cannot be read in full.
   */
  function* exportChunks(filePath, format, state, opts = {}) {
    const chunkSize = Math.max(1, (testHooks && testHooks.exportChunkSize) || DEFAULT_CHUNK);
    if (!fs.existsSync(filePath)) {
      if (format === 'csv') yield CSV_HEADER_LINE + '\n';
      if (format === 'timesketch-csv') yield TIMESKETCH_CSV_HEADER_LINE + '\n';
      state.result = { format, valid: true, total: 0, verified: 0, broken_index: null, error: null, tip_hash: genesisHash, bytes: 0 };
      return;
    }
    let fd;
    let size;
    try {
      fd = fs.openSync(filePath, 'r');
      const st = fs.fstatSync(fd);
      // Windows opens a folder for reading without an error: a folder at the log path is unreadable, as elsewhere.
      if (st.isDirectory()) { const e = new Error('is a directory'); e.code = 'EISDIR'; throw e; }
      size = typeof opts.size === 'number' ? opts.size : st.size;
      if (st.size < size) { const e = new Error('the log got shorter'); e.code = 'ESHRUNK'; throw e; }
    } catch (e) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
      throw readError(e);
    }

    let lastByte = 0x0a;
    const checker = createChecker(() => size === 0 || lastByte === 0x0a);
    const text = new TextDecoder('utf-8', { ignoreBOM: true });
    const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let total = 0;
    let tipText = null;
    // The line before the current one, held back until we know whether it is the last.
    let held = null;
    let csvParts = [];
    let csvLen = 0;
    if (format === 'csv') { csvParts.push(CSV_HEADER_LINE + '\n'); csvLen = CSV_HEADER_LINE.length + 1; }
    if (format === 'timesketch-csv') { csvParts.push(TIMESKETCH_CSV_HEADER_LINE + '\n'); csvLen = TIMESKETCH_CSV_HEADER_LINE.length + 1; }
    const timesketch = TIMESKETCH_FORMATS.has(format);

    const flushHeld = (isLast) => {
      checker.check(held.text, held.rec, held.parseError, held.bad, isLast);
      // A Timesketch event is written once its line is checked, so it says whether it verified.
      const rec = held.rec;
      if (timesketch && !held.parseError && rec !== null && typeof rec === 'object' && !Array.isArray(rec)) {
        const line = timesketchLine(format, rec, held.index, checker.ok());
        csvParts.push(line + '\n');
        csvLen += line.length + 1;
      }
      held = null;
    };
    const takeLine = (bytes) => {
      const b = trimBytes(bytes);
      if (b.length === 0) return;
      let lineText;
      let bad = false;
      try {
        lineText = strict.decode(b);
      } catch {
        bad = true;
        lineText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);
      }
      let rec;
      let parseError = null;
      try { rec = JSON.parse(lineText); } catch (e) { parseError = e; }
      if (held) flushHeld(false);
      held = { text: lineText, rec, parseError, bad, index: total };
      total++;
      tipText = lineText;
      if (format === 'csv' && !parseError) {
        let row = null;
        try { row = csvRow(rec); } catch { /* not a record: no row, as before */ }
        if (row !== null) { csvParts.push(row + '\n'); csvLen += row.length + 1; }
      }
    };

    const buf = Buffer.alloc(Math.min(chunkSize, Math.max(size, 1)));
    let pos = 0;
    let carry = [];
    try {
      while (pos < size) {
        if (testHooks && typeof testHooks.beforeExportRead === 'function') testHooks.beforeExportRead(pos);
        let n;
        try {
          n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
        } catch (e) {
          throw readError(e);
        }
        if (n === 0) { const e = new Error('the log got shorter'); e.code = 'ESHRUNK'; throw readError(e); }
        const chunk = buf.subarray(0, n);
        pos += n;
        lastByte = chunk[n - 1];
        let out = '';
        if (format === 'jsonl') out = text.decode(chunk, { stream: true });
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(0x0a, start);
          if (nl === -1) break;
          if (carry.length) {
            carry.push(chunk.subarray(start, nl));
            takeLine(Buffer.concat(carry));
            carry = [];
          } else {
            takeLine(chunk.subarray(start, nl));
          }
          start = nl + 1;
        }
        if (start < n) carry.push(Buffer.from(chunk.subarray(start, n)));
        if (out) yield out;
        if (csvLen >= CSV_BATCH) { yield csvParts.join(''); csvParts = []; csvLen = 0; }
        // A check-only pass yields an empty piece per chunk, so its caller can pause between chunks.
        if (format === 'none') yield '';
      }
      if (carry.length) { takeLine(Buffer.concat(carry)); carry = []; }
    } catch (e) {
      throw readError(e);
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    if (held) flushHeld(true);

    if (format === 'jsonl') {
      const rest = text.decode();
      // The export always ends with a newline (an empty log gives one newline, as before).
      const tail = size > 0 && lastByte === 0x0a ? rest : rest + '\n';
      if (tail) yield tail;
    } else if ((format === 'csv' || timesketch) && csvParts.length) {
      yield csvParts.join('');
    }

    let tipHash = genesisHash;
    if (tipText !== null) {
      try { tipHash = JSON.parse(tipText).record_hash || genesisHash; } catch { /* not a record */ }
    }
    state.result = { format, ...checker.result(total), tip_hash: tipHash, bytes: size };
  }

  /** Collects a whole export into one string (small logs, the library API). */
  function exportToString(filePath, format) {
    const state = {};
    const parts = [];
    for (const piece of exportChunks(filePath, format, state)) parts.push(piece);
    return { content: parts.join(''), result: state.result };
  }

  /**
   * Writes the export to a Writable stream, waiting when it is full. Read errors reject with an
   * EvidenceLedgerError; write errors reject with the stream's error (err.writeError = true).
   * The stream is not ended. Resolves with state.result.
   */
  async function writeExport(filePath, format, out, opts = {}) {
    let streamError = null;
    const onError = (e) => { if (!streamError) streamError = e; };
    out.on('error', onError);
    const state = {};
    try {
      for (const piece of exportChunks(filePath, format, state, opts)) {
        if (streamError) break;
        if (!piece) continue;
        if (!out.write(piece)) {
          await new Promise((resolve) => {
            const done = () => { out.off('drain', done); out.off('close', done); out.off('error', done); resolve(); };
            out.on('drain', done);
            out.on('close', done);
            out.on('error', done);
          });
        }
        if (out.destroyed && !streamError) streamError = new Error('the output was closed');
      }
    } finally {
      out.off('error', onError);
    }
    if (streamError) { streamError.writeError = true; throw streamError; }
    return state.result;
  }

  return { exportChunks, exportToString, writeExport, CSV_HEADER_LINE };
}

const EXPORT_FORMATS = ['jsonl', 'csv', 'timesketch', 'timesketch-csv'];

module.exports = { createExporter, EXPORT_FORMATS, timesketchMicros, TIMESKETCH_CSV_HEADERS };
