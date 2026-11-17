'use strict';

// Incremental, non-blocking reader of the evidence log for the local dashboard.
//
// The dashboard polls the stats and the chain check. Recomputing both from the whole file on
// every poll costs time proportional to the whole log and blocks the event loop. This index
// keeps the result of the last scan and, when the log only grew, scans just the new bytes,
// continuing the hash chain from the last verified record. It gives the same answers as
// verifyEvidenceLedger and getEvidenceStats, never reports bytes as verified that were not
// verified, and falls back to a full scan on anything but plain growth.

const fs = require('fs');
const crypto = require('crypto');

const CHUNK_BYTES = 256 * 1024;
const TAIL_BLOCK_BYTES = 4096;
// Even when every check passes, the whole log is verified again after this long. Plain growth is
// recognised from the file's size, inode and time plus the last block already verified; this
// periodic full pass also catches an edit of an earlier record made while records were appended.
const DEFAULT_FULL_EVERY_MS = 5 * 60 * 1000;

// ignoreBOM keeps a BOM in the text (so JSON.parse rejects it) instead of dropping it.
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LENIENT = new TextDecoder('utf-8', { ignoreBOM: true });

const isWs = (b) => b === 0x20 || b === 0x09 || b === 0x0d;
function trimBytes(buf) {
  let a = 0;
  let b = buf.length;
  while (a < b && isWs(buf[a])) a++;
  while (b > a && isWs(buf[b - 1])) b--;
  return buf.subarray(a, b);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {string} filePath
 * @param {{canonicalForms: Function, genesisHash: string, recordStart: string, truncatedTailResult: Function}} deps
 * @param {{limit?: number, fullEveryMs?: number}} [opts]
 */
function createLedgerIndex(filePath, deps, opts = {}) {
  const limit = typeof opts.limit === 'number' ? opts.limit : 50;
  const fullEveryMs = typeof opts.fullEveryMs === 'number' ? opts.fullEveryMs : DEFAULT_FULL_EVERY_MS;
  const { canonicalForms, genesisHash, recordStart, truncatedTailResult } = deps;

  let state = null; // result of the last scan, see newState()
  let inflight = null;
  const counters = { fullScans: 0, incrementalScans: 0, cacheHits: 0 };

  function newState() {
    return {
      dev: 0, ino: 0, size: 0, mtimeMs: 0, // file identity at the time of the scan
      offset: 0, // bytes up to and including the last newline (complete lines only)
      tailDigest: sha256(Buffer.alloc(0)), // digest of the last block before offset
      fullAt: Date.now(),
      lines: 0, // non-empty lines seen, tail included while scanning
      prev: genesisHash,
      failure: null, // first problem of the chain check, sticky
      blocked: 0, allowed: 0, shadows: 0,
      topRules: Object.create(null), topTools: Object.create(null),
      recent: [], // oldest first, at most `limit`
    };
  }
  function cloneState(s) {
    return Object.assign({}, s, {
      topRules: Object.assign(Object.create(null), s.topRules),
      topTools: Object.assign(Object.create(null), s.topTools),
      recent: s.recent.slice(),
    });
  }

  // Handles one non-empty line (already trimmed), exactly as verifyEvidenceLedger and
  // getEvidenceStats do for the same line.
  function ingest(st, chunk) {
    const idx = st.lines++;
    let text;
    let badUtf8 = false;
    try {
      text = STRICT.decode(chunk);
    } catch {
      badUtf8 = true;
      text = LENIENT.decode(chunk);
    }
    let rec;
    let parseError = null;
    try {
      rec = JSON.parse(text);
    } catch (e) {
      parseError = e;
    }

    if (!st.failure) {
      if (badUtf8) {
        st.failure = { index: idx, error: `Invalid UTF-8 bytes at line ${idx + 1}: the log was corrupted or modified.` };
      } else if (parseError) {
        st.failure = {
          index: idx, kind: 'json', cutStart: text.startsWith(recordStart),
          error: `Malformed JSON at line ${idx + 1}: ${parseError.message}`,
        };
      } else if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
        st.failure = { index: idx, error: `Malformed record at line ${idx + 1}: not a JSON object.` };
      } else if (rec.prev_hash !== st.prev) {
        st.failure = {
          index: idx,
          error: `Broken chain link at line ${idx + 1} (record ${rec.id}): expected prev_hash ${st.prev.slice(0, 8)}... but found ${rec.prev_hash?.slice(0, 8)}...`,
        };
      } else {
        const { record_hash, ...baseRecord } = rec;
        const prev = st.prev;
        const hashOf = (t) => crypto.createHash('sha256').update(prev + ':' + t).digest('hex');
        if (!canonicalForms(baseRecord).some((t) => hashOf(t) === record_hash)) {
          st.failure = {
            index: idx,
            error: `Tamper detected at line ${idx + 1} (record ${rec.id}): hash mismatch. The content of this log was altered!`,
          };
        } else {
          st.prev = record_hash;
        }
      }
    }

    if (parseError || rec === null || typeof rec !== 'object') return;
    if (rec.verdict === 'shadow') {
      st.shadows++;
    } else if (rec.verdict === 'block') {
      st.blocked++;
      if (rec.rule) st.topRules[rec.rule] = (st.topRules[rec.rule] || 0) + 1;
    } else {
      st.allowed++;
    }
    if (rec.tool_name) st.topTools[rec.tool_name] = (st.topTools[rec.tool_name] || 0) + 1;
    st.recent.push(rec);
    if (st.recent.length > limit) st.recent.shift();
  }

  // Reads [from, to) of the open file in chunks, feeding complete lines to ingest. Returns the
  // bytes after the last newline (an unfinished line), which are not part of st.offset.
  async function scanRange(fh, st, from, to) {
    let pos = from;
    let carry = Buffer.alloc(0);
    st.offset = from;
    while (pos < to) {
      const want = Math.min(CHUNK_BYTES, to - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      const base = pos - data.length; // file offset of data[0]
      let start = 0;
      for (;;) {
        const nl = data.indexOf(0x0a, start);
        if (nl === -1) break;
        const line = trimBytes(data.subarray(start, nl));
        if (line.length) ingest(st, line);
        start = nl + 1;
        st.offset = base + start;
      }
      carry = Buffer.from(data.subarray(start));
      await yieldToLoop();
    }
    return carry;
  }

  async function readBlock(fh, end) {
    const start = Math.max(0, end - TAIL_BLOCK_BYTES);
    const buf = Buffer.alloc(end - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got === buf.length ? buf : buf.subarray(0, got);
  }

  function resultsOf(st, tailLine, endsWithNewline) {
    let view = st;
    if (tailLine && tailLine.length) {
      view = cloneState(st);
      ingest(view, tailLine);
    }
    let verify;
    const f = view.failure;
    if (!f) {
      verify = { valid: true, total: view.lines, verified: view.lines, broken_index: null, error: null };
    } else if (f.kind === 'json' && f.cutStart && f.index === view.lines - 1 && !endsWithNewline) {
      verify = truncatedTailResult(view.lines, f.index);
    } else {
      verify = { valid: false, total: view.lines, verified: f.index, broken_index: f.index, error: f.error };
    }
    const stats = {
      total: view.lines,
      blocks: view.blocked, blocked: view.blocked,
      allows: view.allowed, allowed: view.allowed,
      shadows: view.shadows,
      valid: verify.valid,
      error: verify.error,
      top_rules: Object.assign({}, view.topRules),
      top_tools: Object.assign({}, view.topTools),
      recent: view.recent.slice().reverse(),
    };
    return { stats, verify };
  }

  const missing = () => ({
    stats: { total: 0, blocks: 0, blocked: 0, allows: 0, allowed: 0, shadows: 0, valid: true, top_rules: {}, top_tools: {}, recent: [] },
    verify: { valid: true, total: 0, verified: 0, broken_index: null, error: null },
  });
  const unreadable = (e) => {
    const message = `Cannot read the evidence log: ${e.code || e.message}`;
    return {
      stats: { total: 0, blocks: 0, blocked: 0, allows: 0, allowed: 0, shadows: 0, valid: false, error: message, top_rules: {}, top_tools: {}, recent: [] },
      verify: { valid: false, total: 0, verified: 0, broken_index: 0, error: message },
    };
  };

  async function refresh() {
    let quick;
    try {
      quick = await fs.promises.stat(filePath);
    } catch (e) {
      state = null;
      if (e.code === 'ENOENT') return missing();
      return unreadable(e);
    }
    if (state && state.dev === quick.dev && state.ino === quick.ino
        && state.size === quick.size && state.mtimeMs === quick.mtimeMs) {
      counters.cacheHits++;
      return state.results;
    }
    let fh;
    try {
      fh = await fs.promises.open(filePath, 'r');
      const stt = await fh.stat();
      if (stt.isDirectory()) { const e = new Error('is a directory'); e.code = 'EISDIR'; throw e; }

      let st = null;
      let from = 0;
      const grew = state && state.dev === stt.dev && state.ino === stt.ino
        && stt.size > state.size && stt.mtimeMs >= state.mtimeMs
        && Date.now() - state.fullAt < fullEveryMs;
      if (grew) {
        // The bytes already verified must still be there: compare the last block before the offset.
        const block = await readBlock(fh, state.offset);
        if (sha256(block) === state.tailDigest) {
          st = cloneState(state);
          from = state.offset;
        }
      }
      if (st) counters.incrementalScans++; else { st = newState(); counters.fullScans++; }

      const carry = await scanRange(fh, st, from, stt.size);
      st.dev = stt.dev; st.ino = stt.ino; st.size = stt.size; st.mtimeMs = stt.mtimeMs;
      st.tailDigest = sha256(await readBlock(fh, st.offset));
      const last = stt.size > 0 ? Buffer.alloc(1) : null;
      if (last) await fh.read(last, 0, 1, stt.size - 1);
      const endsWithNewline = !last || last[0] === 0x0a;
      st.results = resultsOf(st, trimBytes(carry), endsWithNewline);
      state = st;
      return st.results;
    } catch (e) {
      state = null;
      return unreadable(e);
    } finally {
      if (fh) try { await fh.close(); } catch { /* ignore */ }
    }
  }

  return {
    /** Current { stats, verify }. Callers that ask while a scan runs share its result. */
    get() {
      if (!inflight) inflight = refresh().finally(() => { inflight = null; });
      return inflight;
    },
    counters,
  };
}

module.exports = { createLedgerIndex };
