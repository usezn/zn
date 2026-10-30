'use strict';
/**
 * Local audit log: ~/.zn/audit.jsonl, one JSON record per line, chained
 * with HMAC-SHA256 under a local key (kept inside the encrypted vault, so
 * only an unlocked daemon can append or verify).
 *
 * Record: {v, seq, ts, secret, mode, agent, tool, argv0, host, decision, reason, prev, mac}
 *   prev = mac of the previous record (64 zeros for the first one)
 *   mac  = HMAC(key, JSON of every other field, in this order)
 *
 * Segments. When the active log passes a size limit, the daemon appends a
 * final record (decision "rotate", reason "segment:<n>") and renames the file
 * to audit.<n>.jsonl; the next record, in a new audit.jsonl, continues the
 * chain (prev = mac of the rotate record, seq + 1). Closed segments are never
 * deleted by zn. A chain check, an export and an upload walk the segments in
 * order and then the active file.
 *
 * Metadata only. Fields are whitelisted and format-checked; anything else
 * is dropped. Values never enter the log, and neither do hashes of values
 * (a hash of a low-entropy value is reversible). As a last guard, any field
 * that contains a known secret value is replaced with "[redacted]".
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);
const FIELDS = ['secret', 'mode', 'agent', 'tool', 'argv0', 'host', 'decision', 'reason'];
const MODES = new Set(['proxy', 'env', 'file', 'named', 'detected', 'resolve', 'set', 'remove', 'unlock', 'lock', 'expire']);
const DECISIONS = new Set(['allow', 'deny', 'warn', 'ask', 'ask:yes', 'ask:no', 'restore', 'withhold', 'error']);
const FORMATS = {
  secret: /^[A-Z0-9_]{1,80}$/,
  agent: /^[A-Za-z0-9_.:/-]{1,64}$/,
  tool: /^[A-Za-z0-9_.:/-]{1,64}$/,
  argv0: /^[A-Za-z0-9_.+-]{1,64}$/,
  host: /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/,
  reason: /^[A-Za-z0-9_:.-]{1,64}$/,
};

function cleanField(name, value, knownValues) {
  if (value === undefined || value === null || value === '') return undefined;
  let v = String(value);
  if (knownValues) {
    for (const secret of knownValues) {
      if (secret && secret.length >= 8 && v.includes(secret)) return '[redacted]';
    }
  }
  if (name === 'mode') return MODES.has(v) ? v : 'other';
  if (name === 'decision') return DECISIONS.has(v) ? v : 'other';
  if (name === 'argv0') v = v.split(/[\\/]/).pop().split(/\s/)[0];
  if (name === 'host') v = v.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]*@/, '').split('/')[0];
  return FORMATS[name].test(v) ? v : '[invalid]';
}

/** Whitelist and format-check an event. */
function sanitize(event, knownValues) {
  const out = {};
  for (const f of FIELDS) {
    const v = cleanField(f, event && event[f], knownValues);
    if (v !== undefined) out[f] = v;
  }
  return out;
}

function macOf(key, record) {
  return crypto.createHmac('sha256', key).update(JSON.stringify(record)).digest('hex');
}

/*
 * forEachLine(file, fn, {chunkSize, maxLine}) -> boolean (false when the file does not exist)
 * Reads the file in chunks and calls fn(line, lineNo) for every non-empty line,
 * so a log of any size is never held in one string (a single string over
 * ~512 MiB throws ERR_STRING_TOO_LONG). A line longer than maxLine bytes
 * (default 4 MiB; the daemon never writes one) is handed over as null.
 * fn returns true to stop early. Read errors other than ENOENT are thrown.
 */
function forEachLine(file, fn, opts) {
  const o = opts || {};
  const chunkSize = Number.isInteger(o.chunkSize) && o.chunkSize > 0 ? o.chunkSize : 1024 * 1024;
  const maxLine = Number.isInteger(o.maxLine) && o.maxLine > 0 ? o.maxLine : 4 * 1024 * 1024;
  const own = o.fd === undefined;
  let fd = o.fd;
  if (own) {
    try { fd = fs.openSync(file, 'r'); } catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  }
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let parts = [];
    let partLen = 0;
    let tooLong = false;
    let lineNo = 0;
    const emit = (bytes) => {
      if (!tooLong && bytes.length === 0) return false;
      lineNo += 1;
      return fn(tooLong ? null : bytes.toString('utf8'), lineNo) === true;
    };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkSize, null);
      if (n === 0) break;
      let start = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, start);
        if (nl < 0 || nl >= n) break;
        let bytes = buf.subarray(start, nl);
        if (partLen > 0) { parts.push(Buffer.from(bytes)); bytes = Buffer.concat(parts); }
        const stop = emit(bytes);
        parts = []; partLen = 0; tooLong = false;
        if (stop) return true;
        start = nl + 1;
      }
      if (start < n && !tooLong) {
        partLen += n - start;
        if (partLen > maxLine) { tooLong = true; parts = []; partLen = 1; } else parts.push(Buffer.from(buf.subarray(start, n)));
      }
    }
    if (partLen > 0 || tooLong) emit(tooLong ? Buffer.alloc(0) : Buffer.concat(parts));
    return true;
  } finally {
    if (own) fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------------ */
/* Segments                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_SEGMENT_BYTES = 128 * 1024 * 1024;

function splitName(file) {
  const ext = path.extname(file);
  return { dir: path.dirname(file), ext, stem: path.basename(file, ext) };
}

/* n when `name` is a closed segment of this log (audit.<n>.jsonl, n canonical and >= 1), else null. */
function segmentNumber(file, name) {
  const { ext, stem } = splitName(file);
  if (!name.startsWith(stem + '.') || !name.endsWith(ext)) return null;
  const mid = name.slice(stem.length + 1, name.length - ext.length);
  if (!/^[1-9]\d{0,8}$/.test(mid)) return null;
  return Number(mid);
}

function segmentPath(file, n) {
  const { dir, ext, stem } = splitName(file);
  return path.join(dir, stem + '.' + n + ext);
}

/* The closed segments of this log that are regular files: [{n, file}] in order. A link is never one. */
function segments(file) {
  let names;
  try { names = fs.readdirSync(splitName(file).dir); } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return []; throw err; }
  const out = [];
  for (const name of names) {
    const n = segmentNumber(file, name);
    if (n === null) continue;
    const f = path.join(splitName(file).dir, name);
    let st;
    try { st = fs.lstatSync(f); } catch (err) { continue; }
    if (st.isFile()) out.push({ n, file: f });
  }
  return out.sort((a, b) => a.n - b.n);
}

/* Every file of the log, oldest first: the closed segments, then the active one ({n: null}). */
function logFiles(file) {
  return segments(file).map((s) => ({ n: s.n, file: s.file })).concat([{ n: null, file }]);
}

function isRotate(rec) {
  return !!rec && rec.decision === 'rotate' && typeof rec.reason === 'string' && /^segment:[1-9]\d{0,8}$/.test(rec.reason);
}

/*
 * walkLog(file, onLine, onFileEnd, opts) -> boolean (false when no part of the log exists)
 * Calls onLine(line, lineNo, {n}) for every non-empty line of the segments in
 * order and then of the active file (lineNo counts across all of them; n is the
 * segment number, null for the active file). onLine returns true to stop.
 * onFileEnd({n}) runs after each file that was read to its end. opts.fromSeq
 * skips closed segments whose last record is older than that sequence number.
 * The active file is opened before the segments are listed again, so a rotation
 * that happens while another process reads still gives it every record once.
 */
function walkLog(file, onLine, onFileEnd, opts) {
  const o = opts || {};
  let list;
  let afd = null;
  for (let attempt = 0; ; attempt++) {
    list = segments(file);
    try { afd = fs.openSync(file, 'r'); } catch (err) { if (err.code !== 'ENOENT') throw err; afd = null; }
    if (segments(file).length === list.length || attempt >= 4) break;
    if (afd !== null) { fs.closeSync(afd); afd = null; }
  }
  try {
    let any = false;
    let lineNo = 0;
    const items = list.map((s) => ({ n: s.n, file: s.file, fd: undefined })).concat([{ n: null, file, fd: afd }]);
    for (const it of items) {
      if (it.n === null && afd === null) continue;
      if (it.n !== null && Number.isInteger(o.fromSeq) && o.fromSeq > 1) {
        let last = null;
        try { last = lastRecord(it.file); } catch (err) { last = null; }
        if (last && Number.isInteger(last.seq) && last.seq < o.fromSeq) { any = true; continue; }
      }
      const fo = { chunkSize: o.chunkSize, maxLine: o.maxLine };
      if (it.fd !== undefined) fo.fd = it.fd;
      let stopped = false;
      const base = lineNo;
      const ex = forEachLine(it.file, (text, ln) => {
        lineNo = base + ln;
        stopped = onLine(text, lineNo, { n: it.n }) === true;
        return stopped;
      }, fo);
      if (!ex) continue;
      any = true;
      if (stopped) return true;
      if (onFileEnd && onFileEnd({ n: it.n }) === true) return true;
    }
    return any;
  } finally {
    if (afd !== null) fs.closeSync(afd);
  }
}

/* Same as forEachLine, over the whole log (closed segments, then the active file). */
function forEachLogLine(file, fn, opts) {
  return walkLog(file, fn, null, opts);
}

/* The newest record of the whole log: the active file's, or (no active file yet, as after a crash
 * between the rename and the first new record) the last record of the newest closed segment. */
function tailRecord(file) {
  const a = lastRecord(file);
  if (a) return a;
  const segs = segments(file);
  return segs.length ? lastRecord(segs[segs.length - 1].file) : null;
}

/* Last record of the log (reads only the tail of the file). */
function lastRecord(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  try {
    const st = fs.fstatSync(fd);
    // Windows opens a directory for reading without error and reports size 0: that is not an empty log.
    if (!st.isFile()) { const e = new Error('the audit log is not a regular file'); e.code = 'EISDIR'; throw e; }
    const size = st.size;
    if (size === 0) return null;
    let chunk = 4096;
    for (;;) {
      const len = Math.min(size, chunk);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      // Drop trailing newlines without a regex: /\n+$/ backtracks on a long run of
      // newlines that is not at the end of the chunk.
      let end = len;
      while (end > 0 && buf[end - 1] === 0x0a) end--;
      const text = buf.toString('utf8', 0, end);
      const nl = text.lastIndexOf('\n');
      if (nl >= 0 || len === size) return JSON.parse(text.slice(nl + 1));
      chunk *= 4;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * append(event, {file, key, knownValues}) -> record
 * key: Buffer or hex string (32 bytes). Single writer (the daemon).
 */
function append(event, opts) {
  const o = opts || {};
  const key = Buffer.isBuffer(o.key) ? o.key : Buffer.from(String(o.key || ''), 'hex');
  if (key.length < 32) throw new Error('audit key missing');
  const file = o.file;
  const last = tailRecord(file);
  // The rotate record is built here only: sanitize never lets a caller write the "rotate" decision.
  const fields = o.rotateSegment ? { decision: 'rotate', reason: 'segment:' + o.rotateSegment } : sanitize(event, o.knownValues);
  const record = Object.assign(
    { v: 1, seq: last ? last.seq + 1 : 1, ts: new Date().toISOString() },
    fields,
    { prev: last ? last.mac : GENESIS },
  );
  record.mac = macOf(key, record);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // Flushed to disk before the vault saves its checkpoint of this record: after a
  // power loss the checkpoint then never points past the end of the log.
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(record) + '\n');
    try { fs.fsyncSync(fd); } catch (err) { /* a file system without fsync: keep going */ }
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform !== 'win32') { try { fs.chmodSync(file, 0o600); } catch (err) { /* ignore */ } }
  return record;
}

/**
 * rotate({file, key, maxBytes}) -> the rotate record, or null when nothing was done
 * Called by the daemon (the only writer) before it appends. When the active
 * file has reached maxBytes it appends the rotate record and renames the file
 * to audit.<n>.jsonl, n being one more than the newest closed segment. When the
 * file already ends with a rotate record (a crash between the two steps) it
 * only finishes the rename. A target that already exists is never overwritten.
 * maxBytes missing or not a positive integer: no rotation.
 */
function rotate(opts) {
  const o = opts || {};
  const file = o.file;
  if (!Number.isInteger(o.maxBytes) || o.maxBytes < 1) return null;
  let st;
  try { st = fs.statSync(file); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  if (!st.isFile() || st.size === 0) return null;
  const segs = segments(file);
  const next = (segs.length ? segs[segs.length - 1].n : 0) + 1;
  let rec = lastRecord(file);
  if (isRotate(rec)) {
    if (rec.reason !== 'segment:' + next) throw new Error('the audit log ends with an unexpected rotate record');
  } else {
    if (st.size < o.maxBytes) return null;
    rec = append({}, { file, key: o.key, rotateSegment: next });
  }
  const target = segmentPath(file, next);
  if (fs.existsSync(target)) throw new Error('the audit log segment ' + path.basename(target) + ' already exists');
  fs.renameSync(file, target);
  if (process.platform !== 'win32') {
    try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch (err) { /* best effort */ }
  }
  return rec;
}

/**
 * checkHead(file, head) -> {ok, found?, reason?}
 * The daemon is the only writer, so the last record in the file must be the
 * one it remembers (sequence number and MAC). A different tail means the log
 * was changed behind the daemon's back. head null: nothing to compare.
 */
function checkHead(file, head) {
  if (!head) return { ok: true };
  let last;
  try { last = tailRecord(file); } catch (err) {
    return { ok: false, found: null, reason: 'the last record of the log cannot be read' };
  }
  if (!last) return { ok: false, found: null, reason: 'the log is empty or missing, but the vault expects ' + head.seq + ' records' };
  if (last.seq === head.seq && typeof head.mac === 'string' && last.mac === head.mac) return { ok: true };
  const found = { seq: last.seq, mac: last.mac };
  return {
    ok: false,
    found,
    reason: last.seq < head.seq
      ? 'log truncated (vault expects ' + head.seq + ' records, the log ends at ' + last.seq + ')'
      : 'the last record of the log is not the one the vault remembers',
  };
}

/**
 * verify({file, key, checkpoint}) -> {ok, records, error?, line?}
 * The log is read in chunks, never as one string. A file that cannot be read
 * throws (an IO error is not a finding: callers must not call it tampering).
 * Checks every MAC, the prev links and the sequence numbers.
 * checkpoint: {seq, mac}, the last record the vault remembers. The log must
 * reach that sequence number and the record there must carry that MAC, so a
 * tail lost after a crash (or swapped for another valid-looking one) is
 * reported. Records written after the checkpoint are fine.
 */
function verify(opts) {
  const o = opts || {};
  const key = Buffer.isBuffer(o.key) ? o.key : Buffer.from(String(o.key || ''), 'hex');
  const cp = o.checkpoint && Number.isInteger(o.checkpoint.seq) && o.checkpoint.seq > 0 ? o.checkpoint : null;
  let prev = GENESIS;
  let seq = 0;
  let count = 0;
  let failure = null;
  const fail = (line, error) => { failure = { ok: false, records: line - 1, line, error }; return true; };
  let fileLast = null; // the last record of the file being read
  const exists = walkLog(o.file, (text, line) => {
    let rec;
    try { rec = JSON.parse(text); } catch (err) { rec = undefined; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return fail(line, 'unparseable record');
    const mac = rec.mac;
    delete rec.mac;
    const expected = macOf(key, rec);
    if (typeof mac !== 'string' || mac.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(expected, 'hex'))) return fail(line, 'bad mac');
    if (rec.prev !== prev) return fail(line, 'broken chain');
    if (rec.seq !== seq + 1) return fail(line, 'bad sequence');
    prev = mac;
    seq = rec.seq;
    count = line;
    fileLast = rec;
    if (cp && seq === cp.seq && mac !== cp.mac) {
      return fail(line, 'log differs from the vault checkpoint (record ' + seq + ' has a different MAC)');
    }
    return false;
  }, (ctx) => {
    // A closed segment ends with its own rotate record, so its number is vouched for by the MAC.
    const last = fileLast;
    fileLast = null;
    if (ctx.n !== null && !(isRotate(last) && last.reason === 'segment:' + ctx.n)) {
      return fail(count + 1, 'segment ' + ctx.n + ' does not end with its rotate record');
    }
    return false;
  }, { chunkSize: o.chunkSize, maxLine: o.maxLine });
  if (!exists) {
    return cp ? { ok: false, records: 0, error: 'log truncated (vault expects ' + cp.seq + ' records)' } : { ok: true, records: 0 };
  }
  if (failure) return failure;
  if (cp && seq < cp.seq) {
    return { ok: false, records: count, error: 'log truncated (vault expects ' + cp.seq + ' records)' };
  }
  return { ok: true, records: count };
}

function parseSince(since) {
  if (since === undefined || since === null || since === '') return null;
  if (since instanceof Date) return since.getTime();
  if (typeof since === 'number') return since;
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(String(since));
  if (m) return Date.now() - Number(m[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  const t = Date.parse(String(since));
  if (Number.isNaN(t)) throw new Error('invalid since: ' + since);
  return t;
}

/**
 * read({file, since, limit}) -> events[] (oldest first)
 * since: Date, epoch ms, ISO string or a duration such as "1d" / "12h".
 * limit: keep only the newest N. Reading needs no key; it does not verify
 * the chain (use verify for that).
 */
function read(opts) {
  const o = opts || {};
  const file = o.file || require('./store').paths(o).auditFile;
  const from = parseSince(o.since);
  const limit = Number(o.limit) > 0 ? Number(o.limit) : 0;
  let out = [];
  forEachLogLine(file, (line) => {
    if (line === null) return false;
    let rec;
    try { rec = JSON.parse(line); } catch (err) { return false; }
    if (!rec || typeof rec !== 'object') return false;
    if (from !== null && Date.parse(rec.ts) < from) return false;
    const ev = { seq: rec.seq, ts: rec.ts };
    for (const f of FIELDS) if (rec[f] !== undefined) ev[f] = rec[f];
    out.push(ev);
    // Keep only about the newest `limit` events while reading.
    if (limit && out.length >= limit * 2) out = out.slice(-limit);
    return false;
  });
  return limit ? out.slice(-limit) : out;
}

module.exports = {
  append, verify, checkHead, read, sanitize, lastRecord, tailRecord, forEachLine, forEachLogLine,
  rotate, segments, logFiles, segmentNumber, segmentPath, isRotate, DEFAULT_SEGMENT_BYTES, FIELDS, GENESIS,
};
