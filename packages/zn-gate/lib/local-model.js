'use strict';

/*
 * Optional on-device prompt-injection check (spike, off by default).
 *
 * Turned on with ZN_LOCAL_MODEL=1. It runs the Galvanize 2 model (INT8 ONNX) in
 * this process with onnxruntime-node, so the text never leaves the machine.
 *
 *  - The model files are downloaded only by an explicit `pull()` (never by
 *    analyze), checked against a sha256 pinned in this file, and cached under
 *    ~/.zn/models (ZN_HOME or ZN_MODEL_DIR change the place).
 *  - Once cached, no network is used.
 *  - onnxruntime-node and @huggingface/tokenizers are optional: if they are not
 *    installed, or the files are not cached, analyze() reports why and the
 *    caller keeps its normal path.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const PIN = {
  id: 'galvanize-2-int8',
  repo: 'usezn/Galvanize-2',
  revision: '48e02933fb4414b95b0cca7d874296a2dd451876',
  // Probability 0.662 expressed as a margin (logit INJECTION minus logit SAFE).
  marginThreshold: 0.6721660494804383,
  threshold: 0.661988004118821,
  maxTokens: 512,
  // sha256 null = not published yet: pull() refuses it.
  files: [
    { name: 'model_int8.onnx', remote: 'onnx/model_int8.onnx', sha256: null, bytes: null },
    { name: 'tokenizer.json', remote: 'tokenizer.json', bytes: 34387554,
      sha256: '8334ca456f647553e290d6700ddf1a772785d135320dac839599b3c046b43ef1' },
    { name: 'tokenizer_config.json', remote: 'tokenizer_config.json', bytes: 682,
      sha256: '80fd3e43697c68f25c40c6a6a7573709de6e2032edf0bcf5bd4b042185c39afc' },
  ],
};

const WINDOW_BODY = 510;
const WINDOW_STRIDE = 256;
const MAX_WINDOWS = 8;
// Tokenizing is the slow part for huge inputs (about 1 s per 200k characters), so the text is cut here; 8 windows cover far less.
const MAX_CHARS = 24000;
const HOSTS = /(^|\.)(huggingface\.co|hf\.co)$/;

// Same whitespace set as Python's str.split(), so the text is flattened as in training and serving.
const PY_WS = /[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

function flatten(text) {
  return String(text == null ? '' : text).split(PY_WS).filter(Boolean).join(' ');
}

function isEnabled(options = {}) {
  if (options.localModel === false) return false;
  return Boolean(options.localModel) || process.env.ZN_LOCAL_MODEL === '1';
}

function modelDir(env = process.env) {
  if (env.ZN_MODEL_DIR) return env.ZN_MODEL_DIR;
  const home = env.ZN_HOME || path.join(os.homedir(), '.zn');
  return path.join(home, 'models', PIN.id);
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (_) { return null; }
}

/** Cheap check done on every load: same files as when pull() verified them (size and mtime). */
function cachedProblem(dir) {
  const man = readManifest(dir);
  if (!man || man.revision !== PIN.revision) return 'model files are not cached (run the model pull command)';
  for (const f of PIN.files) {
    const m = man.files && man.files[f.name];
    let st;
    try { st = fs.statSync(path.join(dir, f.name)); } catch (_) { return 'missing ' + f.name; }
    if (!m || m.bytes !== st.size || m.mtimeMs !== st.mtimeMs) return f.name + ' changed since it was verified (pull again)';
    if (f.sha256 && m.sha256 !== f.sha256) return f.name + ' does not match the pinned hash';
  }
  return null;
}

function status(env = process.env) {
  const dir = modelDir(env);
  const problem = cachedProblem(dir);
  let runtime = true;
  try { require.resolve('onnxruntime-node'); require.resolve('@huggingface/tokenizers'); } catch (_) { runtime = false; }
  return { enabled: env.ZN_LOCAL_MODEL === '1', dir, cached: !problem, problem, runtime_installed: runtime, model: PIN.id, revision: PIN.revision };
}

function download(url, dest, maxBytes, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !HOSTS.test(u.hostname)) return reject(new Error('refusing to download from ' + u.hostname));
    https.get(u, { headers: { 'User-Agent': 'zn-gate (model pull)' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u).toString();
        return resolve(download(next, dest, maxBytes, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let n = 0;
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { res.destroy(new Error('file larger than expected')); } });
      res.pipe(out);
      out.on('finish', () => resolve(n));
      res.on('error', (e) => { out.destroy(); reject(e); });
      out.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Download the pinned files (the only network use of this module), verify each
 * sha256, then move it into place. `baseUrl` is for tests.
 */
async function pull(options = {}) {
  const dir = modelDir();
  const unpublished = PIN.files.filter((f) => !f.sha256 && !options.hashes);
  if (unpublished.length) throw new Error('the INT8 model is not published yet: ' + unpublished.map((f) => f.name).join(', '));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const man = { revision: PIN.revision, files: {} };
  for (const f of PIN.files) {
    const want = f.sha256 || options.hashes[f.name];
    const base = options.baseUrl || ('https://huggingface.co/' + PIN.repo + '/resolve/' + PIN.revision + '/');
    const tmp = path.join(dir, f.name + '.part');
    try {
      await download(base + f.remote, tmp, f.bytes ? f.bytes + 1024 : 1024 * 1024 * 1024);
      const got = await sha256File(tmp);
      if (got !== want) throw new Error(f.name + ': sha256 mismatch, nothing was installed');
      fs.renameSync(tmp, path.join(dir, f.name));
    } finally {
      try { fs.unlinkSync(tmp); } catch (_) { /* gone already */ }
    }
    const st = fs.statSync(path.join(dir, f.name));
    man.files[f.name] = { sha256: want, bytes: st.size, mtimeMs: st.mtimeMs };
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man, null, 2), { mode: 0o600 });
  return { dir };
}

let backendPromise = null;

/** Real backend: onnxruntime-node + @huggingface/tokenizers, loaded lazily. */
async function loadBackend(env = process.env) {
  const dir = modelDir(env);
  const problem = cachedProblem(dir);
  if (problem && !env.ZN_MODEL_UNVERIFIED) return { error: problem };
  let ort; let Tokenizer;
  try { ort = require('onnxruntime-node'); } catch (_) { return { error: 'onnxruntime-node is not installed (npm install onnxruntime-node)' }; }
  try { ({ Tokenizer } = require('@huggingface/tokenizers')); } catch (_) { return { error: '@huggingface/tokenizers is not installed' }; }
  const tj = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer.json'), 'utf8'));
  const tc = JSON.parse(fs.readFileSync(path.join(dir, 'tokenizer_config.json'), 'utf8'));
  const tok = new Tokenizer(tj, tc);
  const probe = tok.encode('a').ids;
  const specials = { bos: probe[0], eos: probe[probe.length - 1] };
  const threads = Math.max(1, Math.min(4, os.cpus().length));
  const session = await ort.InferenceSession.create(path.join(dir, 'model_int8.onnx'),
    { executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1, graphOptimizationLevel: 'all' });
  return {
    specials,
    tokenize: (flat) => tok.encode(flat, { add_special_tokens: false }).ids,
    async margin(ids) {
      const n = ids.length;
      const input = new ort.Tensor('int64', BigInt64Array.from(ids, (x) => BigInt(x)), [1, n]);
      const mask = new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]);
      const out = await session.run({ input_ids: input, attention_mask: mask }, ['margin']);
      return Number(out.margin.data[0]);
    },
  };
}

function getBackend(options = {}) {
  if (options.localModelBackend) return Promise.resolve(options.localModelBackend);
  if (!backendPromise) backendPromise = loadBackend().then((b) => { if (b.error) backendPromise = null; return b; });
  return backendPromise;
}

/** Highest margin over the first 512 tokens, or over overlapping windows for long text. */
async function score(text, backend, options = {}) {
  let flat = flatten(text);
  let cut = false;
  if (flat.length > MAX_CHARS) { flat = flat.slice(0, MAX_CHARS); cut = true; }
  const ids = backend.tokenize(flat);
  const { bos, eos } = backend.specials;
  const windowed = options.windows !== false && ids.length > WINDOW_BODY;
  const starts = [0];
  if (windowed) {
    for (let s = WINDOW_STRIDE; s + WINDOW_BODY <= ids.length; s += WINDOW_STRIDE) starts.push(s);
    if (starts[starts.length - 1] + WINDOW_BODY < ids.length) starts.push(ids.length - WINDOW_BODY);
  }
  const capped = cut || starts.length > MAX_WINDOWS;
  const used = capped ? starts.slice(0, MAX_WINDOWS) : starts;
  let best = -Infinity;
  for (const s of used) {
    const m = await backend.margin([bos, ...ids.slice(s, s + WINDOW_BODY), eos]);
    if (m > best) best = m;
  }
  return { margin: best, probability: 1 / (1 + Math.exp(-best)), windows: used.length, capped, tokens: ids.length };
}

/**
 * Returns { ready: true, result } with the usual analyze() shape, or
 * { ready: false, reason } when the model cannot run (the caller falls back).
 */
async function analyze(input, options = {}) {
  let backend;
  try { backend = await getBackend(options); } catch (err) { return { ready: false, reason: String(err && err.message || err) }; }
  if (backend.error) return { ready: false, reason: backend.error };
  let s;
  try { s = await score(input, backend, options); } catch (err) { return { ready: false, reason: 'local model failed: ' + (err && err.message || err) }; }
  const block = s.margin >= PIN.marginThreshold;
  const result = {
    verdict: block ? 'block' : 'allow',
    confidence: Math.round((block ? s.probability : 1 - s.probability) * 1000) / 1000,
    rule: block ? 'galvanize2-local' : 'none',
    reason: block ? 'The on-device model rates this text as a likely prompt injection.' : null,
    engine: 'galvanize2-int8-local',
    mode: 'local-model',
    model: { id: PIN.id, revision: PIN.revision },
    score: Math.round(s.probability * 1e4) / 1e4,
    threshold: PIN.threshold,
    local_model: { windows: s.windows, tokens: s.tokens },
  };
  if (s.capped) result.warning = 'The text is longer than the on-device check covers (' + MAX_WINDOWS + ' windows of 512 tokens): the end was not analyzed.';
  return { ready: true, result };
}

module.exports = { PIN, flatten, isEnabled, modelDir, status, pull, score, analyze, cachedProblem, loadBackend };
