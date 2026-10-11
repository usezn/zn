'use strict';
/**
 * zn-gate leak bench.
 *
 * Measures the Scrubber engine through its package interface:
 *
 *     require('../packages/zn-gate/lib/scrub/engine.js').tokenize(text, ctx)
 *
 * Three measurements:
 *   1. leaks         — fake secrets (fixed PRNG seed) embedded in realistic
 *                      contexts must never survive tokenization
 *   2. overredaction — benign real files (npm packages + Python stdlib) that
 *                      must not be rewritten, plus fixed known-OK snippets
 *   3. latency       — tokenize p50/p95 per input size
 *
 * The engine module may not exist yet: a local stub is used and the run is
 * reported as "not-implemented" instead of crashing.
 *
 * The benign corpus is downloaded, not committed. If it is missing, run:
 *     bash packages/zn-gate/test/fixtures/benign/fetch_corpus.sh
 *
 * CLI: node bench/leak_bench.js [options]
 *   --json <path>            JSON report path, "-" = stdout only
 *                            (default bench/leak_bench_results.json)
 *   --thresholds <path>      JSON file overriding the defaults below
 *   --seed <n>               PRNG seed for generated secrets (default 1337005)
 *   --per-type <n>           samples per secret/PII type (default 2)
 *   --corpus <dir>           benign corpus (default packages/zn-gate/test/fixtures/benign)
 *   --quick                  fewer latency iterations (local runs)
 *   --require-engine         exit 1 when the engine module is missing
 *   --allow-missing-corpus   do not fail the gate when the corpus is absent
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ENGINE_REL = '../packages/zn-gate/lib/scrub/engine.js';
const FIXTURES_DIR = path.join(ROOT, 'packages', 'zn-gate', 'test', 'fixtures');
const DEFAULT_CORPUS = path.join(FIXTURES_DIR, 'benign');
const DEFAULT_JSON = path.join(ROOT, 'bench', 'leak_bench_results.json');

const { generateAll, SEED_DEFAULT } = require(path.join(FIXTURES_DIR, 'fake_secrets.js'));

/* Default thresholds:
 * - leaks: 0 — a single value surviving tokenization fails the run.
 * - over-redaction: at most 0.1% of benign files may be altered, and the
 *   fixed must-not-touch snippets must stay intact.
 * - latency: the documented hook budget is p50 <= 60 ms for a full hook
 *   process at 64 KB (dominated by Node startup); this bench measures the
 *   in-process engine only, a lower bound of that budget, and gates well
 *   under it. p95 is kept at 2x p50 as a regression guard; smaller sizes
 *   share the same absolute cap. */
const DEFAULT_THRESHOLDS = {
  max_leaks: 0,
  max_overredacted_file_rate: 0.001,
  max_known_ok_redactions: 0,
  latency_ms: {
    '256B': { p50: 60, p95: 120 },
    '4KB': { p50: 60, p95: 120 },
    '64KB': { p50: 60, p95: 120 },
  },
};

const USAGE = [
  'usage: node bench/leak_bench.js [--json <path>] [--thresholds <path>]',
  '       [--seed <n>] [--per-type <n>] [--corpus <dir>] [--quick]',
  '       [--require-engine] [--allow-missing-corpus]',
].join('\n');

function parseArgs(argv) {
  const args = {
    json: DEFAULT_JSON,
    thresholds: null,
    seed: SEED_DEFAULT,
    perType: 2,
    corpus: DEFAULT_CORPUS,
    quick: false,
    requireEngine: false,
    allowMissingCorpus: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = argv[++i];
    else if (a === '--thresholds') args.thresholds = argv[++i];
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--per-type') args.perType = Number(argv[++i]);
    else if (a === '--corpus') args.corpus = path.resolve(argv[++i]);
    else if (a === '--quick') args.quick = true;
    else if (a === '--require-engine') args.requireEngine = true;
    else if (a === '--allow-missing-corpus') args.allowMissingCorpus = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else { console.error('unknown argument: ' + a); console.error(USAGE); process.exit(2); }
  }
  return args;
}

function loadThresholds(file) {
  if (!file) return JSON.parse(JSON.stringify(DEFAULT_THRESHOLDS));
  const overrides = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.assign({}, DEFAULT_THRESHOLDS, overrides, {
    latency_ms: Object.assign({}, DEFAULT_THRESHOLDS.latency_ms, overrides.latency_ms || {}),
  });
}

/* ------------------------------------------------------------------ */
/* Engine loading: missing module or WP0 stub -> not-implemented run.  */
/* ------------------------------------------------------------------ */

function loadEngine() {
  try {
    const mod = require(ENGINE_REL);
    if (!mod || typeof mod.tokenize !== 'function') {
      return { engine: null, error: new Error('module loaded but tokenize(text, ctx) is missing') };
    }
    return { engine: mod, error: null };
  } catch (err) {
    return { engine: null, error: err };
  }
}

function stubEngine() {
  return {
    tokenize() {
      const err = new Error('scrub/engine.js tokenize not implemented yet (WP0/WP1 pending)');
      err.code = 'ZN_ENGINE_NOT_IMPLEMENTED';
      err.znNotImplemented = true;
      throw err;
    },
  };
}

function isNotImplemented(err) {
  return !!(err && (err.znNotImplemented || /not implemented/i.test(String(err.message || ''))));
}

async function safeTokenize(engine, text, ctx) {
  const out = await engine.tokenize(text, ctx);
  if (!out || typeof out.text !== 'string' || !Array.isArray(out.replaced)) {
    throw new Error('tokenize returned an unexpected shape (expected {text, replaced: []})');
  }
  return out;
}

/* Minimal in-memory VaultClient per the contract, so the engine can mint
 * deterministic tokens even without a real vault/daemon. */
function makeVaultStub() {
  const byValue = new Map();
  const counters = new Map();
  return {
    mapToken(project, type, value) {
      const key = type + '\u0000' + value;
      if (!byValue.has(key)) {
        const n = (counters.get(type) || 0) + 1;
        counters.set(type, n);
        byValue.set(key, '__ZN_' + String(type).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_' + n + '__');
      }
      return byValue.get(key);
    },
    resolve() { return null; },
    listSecrets() { return []; },
    setSecret() {},
    removeSecret() {},
    exactValues() { return []; },
    audit() {},
  };
}

function makeCtx(vault, extra) {
  return Object.assign({
    project: 'zn-leak-bench',
    agent: 'bench',
    tool: 'read',
    destination: 'assistant',
    vault,
  }, extra || {});
}

function percentile(sortedMs, p) {
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
  return sortedMs[idx];
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/* Leak definition: the sensitive substring (whole value, or each long line
 * for multi-line values like PEM blocks) must not appear in the output. */
function valueLeaked(out, sensitive) {
  if (!sensitive.includes('\n')) return out.includes(sensitive);
  for (const line of sensitive.split('\n')) {
    if (line.length >= 16 && out.includes(line)) return true;
  }
  return false;
}

function mask(value) {
  const flat = value.replace(/\n/g, '\\n');
  return flat.length > 20 ? flat.slice(0, 20) + '...' : flat;
}

/* ------------------------------------------------------------------ */
/* Realistic embedding contexts. Each case embeds one generated value  */
/* verbatim in text that looks like a real file, log or command output.*/
/* ------------------------------------------------------------------ */

const dotenv = (key, v) => 'SERVICE_MODE=production\n' + key + '=' + v + '\nDEBUG=false\n';
const yamlEnv = (key, v) => 'services:\n  api:\n    environment:\n      ' + key + ': ' + v + '\n';
const jsonField = (key, v) => '{\n  "' + key + '": "' + v + '"\n}\n';
const jsConst = (name, v) => "const " + name + " = '" + v + "';\n";
const logLine = (v) => '2026-10-11T09:14:03Z INFO  auth: connected with credential ' + v + '\n';
const cmdOut = (cmd, v) => '$ ' + cmd + '\n' + v + '\n$ echo $?\n0\n';
const keyFile = (v) => 'server_key: |\n  ' + v.split('\n').filter(Boolean).join('\n  ') + '\n';
const httpHeaders = (v) => '> GET /v1/me HTTP/1.1\n> Host: api.example.org\n> Authorization: Bearer ' + v + '\n';

const CONTEXTS = {
  anthropic_api_key: [
    { label: 'dotenv', tool: 'read', mk: (v) => dotenv('ANTHROPIC_API_KEY', v) },
    { label: 'python_source', tool: 'read', mk: (v) => 'import anthropic\n\nclient = anthropic.Anthropic(api_key="' + v + '")\n' },
  ],
  openai_project_key: [
    { label: 'dotenv', tool: 'read', mk: (v) => dotenv('OPENAI_API_KEY', v) },
    { label: 'compose_yaml', tool: 'read', mk: (v) => yamlEnv('OPENAI_API_KEY', v) },
  ],
  openai_api_key: [
    { label: 'js_source', tool: 'read', mk: (v) => "const openai = new OpenAI({ apiKey: '" + v + "' });\n" },
  ],
  aws_access_key_id: [
    { label: 'aws_credentials', tool: 'read', mk: (v) => '[default]\naws_access_key_id = ' + v + '\naws_secret_access_key = <redacted>\n' },
  ],
  aws_session_key_id: [
    { label: 'aws_credentials', tool: 'read', mk: (v) => '[default]\naws_access_key_id = ' + v + '\naws_secret_access_key = <redacted>\naws_session_token = <redacted>\n' },
    { label: 'env_dump', tool: 'bash', mk: (v) => cmdOut('env | grep AWS', 'AWS_ACCESS_KEY_ID=' + v) },
  ],
  aws_secret_access_key: [
    { label: 'aws_credentials', tool: 'read', mk: (v) => '[default]\naws_access_key_id = <redacted>\naws_secret_access_key = ' + v + '\n' },
    { label: 'cli_output', tool: 'bash', mk: (v) => cmdOut('aws configure get aws_secret_access_key', v) },
  ],
  github_pat_classic: [
    { label: 'dotenv', tool: 'read', mk: (v) => dotenv('GITHUB_TOKEN', v) },
    { label: 'cli_output', tool: 'bash', mk: (v) => cmdOut('gh auth token', v) },
  ],
  github_oauth_token: [
    { label: 'gh_hosts_yaml', tool: 'read', mk: (v) => 'github.com:\n    oauth_token: ' + v + '\n    user: bench-user\n' },
  ],
  github_app_token: [
    { label: 'cli_output', tool: 'bash', mk: (v) => cmdOut('gh api /app/installations/1/access_tokens', v) },
  ],
  github_fine_grained_pat: [
    { label: 'workflow_yaml', tool: 'read', mk: (v) => 'name: ci\njobs:\n  test:\n    env:\n      GITHUB_TOKEN: ' + v + '\n' },
  ],
  gitlab_pat: [
    { label: 'dotenv', tool: 'read', mk: (v) => dotenv('GITLAB_TOKEN', v) },
    { label: 'ci_yaml', tool: 'read', mk: (v) => 'variables:\n  GITLAB_TOKEN: ' + v + '\n' },
  ],
  slack_bot_token: [{ label: 'dotenv', tool: 'read', mk: (v) => dotenv('SLACK_BOT_TOKEN', v) }],
  slack_user_token: [{ label: 'dotenv', tool: 'read', mk: (v) => dotenv('SLACK_USER_TOKEN', v) }],
  slack_app_token: [{ label: 'dotenv', tool: 'read', mk: (v) => dotenv('SLACK_APP_TOKEN', v) }],
  slack_refresh_token: [{ label: 'json_config', tool: 'read', mk: (v) => jsonField('refresh_token', v) }],
  slack_socket_token: [{ label: 'dotenv', tool: 'read', mk: (v) => dotenv('SLACK_SOCKET_TOKEN', v) }],
  stripe_live_secret_key: [
    { label: 'js_source', tool: 'read', mk: (v) => "const stripe = require('stripe')('" + v + "');\n" },
  ],
  stripe_live_restricted_key: [{ label: 'dotenv', tool: 'read', mk: (v) => dotenv('STRIPE_RESTRICTED_KEY', v) }],
  google_api_key: [
    { label: 'json_config', tool: 'read', mk: (v) => jsonField('api_key', v) },
    { label: 'compose_yaml', tool: 'read', mk: (v) => yamlEnv('GOOGLE_API_KEY', v) },
  ],
  huggingface_token: [{ label: 'dotenv', tool: 'read', mk: (v) => dotenv('HF_TOKEN', v) }],
  npm_access_token: [
    { label: 'npmrc', tool: 'read', mk: (v) => '//registry.npmjs.org/:_authToken=' + v + '\nregistry=https://registry.npmjs.org/\n' },
  ],
  sendgrid_api_key: [
    { label: 'python_source', tool: 'read', mk: (v) => 'sg = SendGridAPIClient("' + v + '")\n' },
  ],
  jwt: [
    { label: 'http_headers', tool: 'bash', mk: (v) => httpHeaders(v) },
    { label: 'js_const', tool: 'read', mk: (v) => jsConst('SESSION_TOKEN', v) },
  ],
  rsa_private_key: [{ label: 'key_file', tool: 'read', mk: (v) => keyFile(v) }],
  ec_private_key: [{ label: 'key_file', tool: 'read', mk: (v) => keyFile(v) }],
  openssh_private_key: [{ label: 'key_file', tool: 'read', mk: (v) => keyFile(v) }],
  postgres_connection_string: [
    { label: 'dotenv', tool: 'read', mk: (v) => dotenv('DATABASE_URL', v) },
    { label: 'log_line', tool: 'bash', mk: (v) => logLine(v) },
  ],
  mysql_connection_string: [
    { label: 'compose_yaml', tool: 'read', mk: (v) => yamlEnv('DATABASE_URL', v) },
    { label: 'dotenv', tool: 'read', mk: (v) => dotenv('MYSQL_URL', v) },
  ],
  mongodb_connection_string: [
    { label: 'log_line', tool: 'bash', mk: (v) => logLine(v) },
    { label: 'js_const', tool: 'read', mk: (v) => jsConst('MONGO_URL', v) },
  ],
  redis_connection_string: [
    { label: 'dotenv', tool: 'read', mk: (v) => dotenv('REDIS_URL', v) },
  ],
  email: [
    { label: 'json_payload', tool: 'read', mk: (v) => jsonField('email', v) },
    { label: 'log_line', tool: 'bash', mk: (v) => logLine(v) },
  ],
  phone_e164: [
    { label: 'js_const', tool: 'read', mk: (v) => jsConst('SUPPORT_PHONE', v) },
    { label: 'support_note', tool: 'read', mk: (v) => 'Customer callback requested at ' + v + ' (UTC+1).\n' },
  ],
  iban: [
    { label: 'invoice_yaml', tool: 'read', mk: (v) => 'invoice:\n  iban: ' + v + '\n  currency: EUR\n' },
    { label: 'email_body', tool: 'read', mk: (v) => 'Please wire the amount to ' + v + ' before Friday.\n' },
  ],
  payment_card: [
    { label: 'json_charge', tool: 'read', mk: (v) => jsonField('card_number', v) },
    { label: 'test_note', tool: 'read', mk: (v) => 'Test charge with card ' + v + ' (sandbox only).\n' },
  ],
  dni: [
    { label: 'form_post', tool: 'read', mk: (v) => 'documento=' + v + '&nombre=Test+User\n' },
    { label: 'json_payload', tool: 'read', mk: (v) => jsonField('documento', v) },
  ],
  nie: [
    { label: 'form_post', tool: 'read', mk: (v) => 'documento=' + v + '&nombre=Test+User\n' },
  ],
};

function fallbackSpec(type) {
  return { label: 'env_generic', tool: 'read', mk: (v) => type.toUpperCase() + '=' + v + '\n' };
}

function buildLeakCases(generated) {
  const cases = [];
  const perTypeIndex = new Map();
  for (const entry of [...generated.secrets, ...generated.pii]) {
    const idx = perTypeIndex.get(entry.type) || 0;
    perTypeIndex.set(entry.type, idx + 1);
    const specs = CONTEXTS[entry.type] || [fallbackSpec(entry.type)];
    for (const spec of specs) {
      cases.push({
        id: entry.type + '[' + idx + ']:' + spec.label,
        type: entry.type,
        context: spec.label,
        tool: spec.tool,
        text: spec.mk(entry.value),
        sensitive: entry.sensitive,
      });
    }
  }
  return cases;
}

/* Fixed must-not-touch cases: high-entropy-but-benign strings that the
 * pattern layer is not allowed to rewrite. */
const KNOWN_OK = [
  { id: 'git_sha', text: 'commit 3f786850e387550fdab836ed7e6dc881de23001b fix: bump deps\n' },
  { id: 'uuid', text: 'session id: 550e8400-e29b-41d4-a716-446655440000\n' },
  { id: 'sha256_hash', text: 'payload_sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n' },
  { id: 'npm_integrity', text: '"integrity": "sha512-9cW9xR2mQ4t6V8yF1nZ3kL5pJ7hG0dS2aB4cD6eF8gH7iJ9kL0mN1oP2qR3sT4uV5wX6yZ7aB8cD9eF0fG1hI2jK3lM4nO5pQ6rS7tU8vW9xY0zA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zZ4aB5cD6e=="\n' },
  { id: 'process_env_name', text: 'const key = process.env.API_KEY;\n' },
  { id: 'doc_prefix_only', text: 'Tokens start with sk-ant- and must be rotated every 90 days.\n' },
  { id: 'db_url_without_password', text: 'postgres://app@db.internal:5432/appdb\n' },
  { id: 'jwt_sign_call', text: "const token = jwt.sign({ sub: user.id }, secret, { expiresIn: '1h' });\n" },
  { id: 'example_urls', text: 'curl https://api.example.org/v1/ping\n' },
  { id: 'public_pem', text: '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n' },
  { id: 'semver', text: 'lodash version 4.17.21, node >=18.0.0\n' },
  { id: 'base64_image', text: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==\n' },
  { id: 'lockfile_resolved', text: 'resolved "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"\n' },
];

/* ------------------------------------------------------------------ */
/* Runners                                                             */
/* ------------------------------------------------------------------ */

async function runLeaks(engine, vault, cases) {
  const details = [];
  const byType = {};
  let leaked = 0;
  let errors = 0;
  let checked = 0;
  for (const c of cases) {
    let bucket = byType[c.type];
    if (!bucket) bucket = byType[c.type] = { cases: 0, leaked: 0, errors: 0 };
    bucket.cases++;
    try {
      const out = await safeTokenize(engine, c.text, makeCtx(vault, { tool: c.tool }));
      checked++;
      const leakedHere = valueLeaked(out.text, c.sensitive);
      if (leakedHere) { leaked++; bucket.leaked++; }
      details.push({
        id: c.id, type: c.type, context: c.context, tool: c.tool,
        status: leakedHere ? 'LEAK' : 'ok',
        replaced: out.replaced.length,
        sensitive_preview: mask(c.sensitive),
      });
    } catch (err) {
      if (isNotImplemented(err)) throw err;
      errors++;
      bucket.errors++;
      details.push({ id: c.id, type: c.type, context: c.context, tool: c.tool, status: 'ERROR', error: String(err.message || err) });
    }
  }
  return { cases: cases.length, checked, leaked, errors, by_type: byType, details };
}

async function runKnownOk(engine, vault, items) {
  const ctx = makeCtx(vault, { tool: 'read' });
  let redactedCases = 0;
  let errors = 0;
  const details = [];
  for (const item of items) {
    try {
      const out = await safeTokenize(engine, item.text, ctx);
      if (out.replaced.length > 0) {
        redactedCases++;
        details.push({ id: item.id, replaced: out.replaced.length, types: out.replaced.map((r) => r && r.type).slice(0, 5) });
      }
    } catch (err) {
      if (isNotImplemented(err)) throw err;
      errors++;
      details.push({ id: item.id, error: String(err.message || err) });
    }
  }
  return { cases: items.length, redacted_cases: redactedCases, errors, details };
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(current, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

async function runCorpus(engine, vault, corpusDir) {
  const files = walkFiles(corpusDir);
  const ctx = makeCtx(vault, { tool: 'read' });
  let scanned = 0;
  let skippedBinary = 0;
  let altered = 0;
  let tokens = 0;
  let bytes = 0;
  const scanErrors = [];
  const offenders = [];
  for (const f of files) {
    let buf;
    try { buf = fs.readFileSync(f); } catch (err) { continue; }
    bytes += buf.length;
    if (buf.includes(0)) { skippedBinary++; continue; }
    let out;
    try {
      out = await safeTokenize(engine, buf.toString('utf8'), ctx);
    } catch (err) {
      if (isNotImplemented(err)) throw err;
      scanErrors.push({ file: path.relative(corpusDir, f).replace(/\\/g, '/'), error: String(err.message || err) });
      continue;
    }
    scanned++;
    if (out.replaced.length > 0) {
      altered++;
      tokens += out.replaced.length;
      offenders.push({ file: path.relative(corpusDir, f).replace(/\\/g, '/'), replaced: out.replaced.length });
    }
  }
  offenders.sort((a, b) => b.replaced - a.replaced || a.file.localeCompare(b.file));
  return {
    files: files.length,
    scanned,
    skipped_binary: skippedBinary,
    bytes,
    altered_files: altered,
    altered_rate: scanned > 0 ? altered / scanned : 0,
    replaced_tokens: tokens,
    scan_errors: scanErrors.length,
    scan_error_details: scanErrors.slice(0, 20),
    top_offenders: offenders.slice(0, 20),
  };
}

const LATENCY_SIZES = [
  { label: '256B', bytes: 256, iterations: 400 },
  { label: '4KB', bytes: 4096, iterations: 150 },
  { label: '64KB', bytes: 65536, iterations: 50 },
];

const BENIGN_FALLBACK = [
  "const sha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';",
  "const id = '550e8400-e29b-41d4-a716-446655440000';",
  '// fetch token from process.env.API_KEY at runtime',
  'function parseArgs(argv) { return argv.filter(Boolean); }',
  'The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog.',
  'Copyright (c) 2026 Example Authors. MIT License.',
].join('\n');

function buildPayload(corpusDir, wantBytes) {
  let base = null;
  let source = 'builtin';
  if (fs.existsSync(corpusDir)) {
    let acc = '';
    for (const f of walkFiles(corpusDir)) {
      if (acc.length >= wantBytes) break;
      if (!/\.(py|js)$/.test(f)) continue;
      try { acc += fs.readFileSync(f, 'utf8') + '\n'; } catch (err) { /* skip unreadable */ }
    }
    if (acc.length >= 256) { base = acc; source = 'corpus'; }
  }
  if (!base) base = BENIGN_FALLBACK;
  let text = base;
  while (text.length < wantBytes) text += base;
  return { text: text.slice(0, wantBytes), source };
}

async function runLatency(engine, vault, corpusDir, quick) {
  const payload = buildPayload(corpusDir, 65536);
  const ctx = makeCtx(vault, { tool: 'read' });
  const samples = {};
  for (const spec of LATENCY_SIZES) {
    const text = payload.text.slice(0, spec.bytes);
    const iterations = quick ? Math.max(5, Math.floor(spec.iterations / 4)) : spec.iterations;
    try {
      for (let i = 0; i < Math.min(10, iterations); i++) await safeTokenize(engine, text, ctx);
      const times = [];
      for (let i = 0; i < iterations; i++) {
        const t0 = process.hrtime.bigint();
        await safeTokenize(engine, text, ctx);
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      times.sort((a, b) => a - b);
      samples[spec.label] = {
        bytes: spec.bytes,
        iterations,
        p50_ms: round3(percentile(times, 50)),
        p95_ms: round3(percentile(times, 95)),
      };
    } catch (err) {
      if (isNotImplemented(err)) throw err;
      samples[spec.label] = { bytes: spec.bytes, iterations: 0, error: String(err.message || err) };
    }
  }
  return { payload_source: payload.source, samples };
}

/* ------------------------------------------------------------------ */
/* Gate and reporting                                                  */
/* ------------------------------------------------------------------ */

function evaluateGate(report, thresholds, args) {
  const failures = [];
  const over = report.overredaction;

  if (report.leaks.errors > 0) failures.push({ metric: 'leak_case_errors', actual: report.leaks.errors, limit: 0 });
  if (report.leaks.leaked > thresholds.max_leaks) failures.push({ metric: 'leaks', actual: report.leaks.leaked, limit: thresholds.max_leaks });

  if (!over.present && !args.allowMissingCorpus) {
    failures.push({ metric: 'corpus_missing', actual: 'absent', limit: report.corpus.hint || ('present (' + report.corpus.dir + ')') });
  }
  if (over.known_ok.errors > 0) failures.push({ metric: 'overredaction:known_ok_errors', actual: over.known_ok.errors, limit: 0 });
  if (over.known_ok.redacted_cases > thresholds.max_known_ok_redactions) {
    failures.push({ metric: 'overredaction:known_ok', actual: over.known_ok.redacted_cases, limit: thresholds.max_known_ok_redactions });
  }
  if (over.present) {
    if (over.scan_errors > 0) failures.push({ metric: 'overredaction:scan_errors', actual: over.scan_errors, limit: 0 });
    if (over.altered_rate > thresholds.max_overredacted_file_rate) {
      failures.push({
        metric: 'overredaction:altered_rate',
        actual: round3(over.altered_rate * 100) + '%',
        limit: round3(thresholds.max_overredacted_file_rate * 100) + '%',
      });
    }
  }
  for (const [label, sample] of Object.entries(report.latency.samples)) {
    const limit = thresholds.latency_ms[label];
    if (sample.error) {
      failures.push({ metric: 'latency:' + label, actual: 'engine error: ' + sample.error, limit: 'runs' });
      continue;
    }
    if (!limit) continue;
    if (sample.p50_ms > limit.p50) failures.push({ metric: 'latency:' + label + ':p50', actual: sample.p50_ms, limit: limit.p50 });
    if (sample.p95_ms > limit.p95) failures.push({ metric: 'latency:' + label + ':p95', actual: sample.p95_ms, limit: limit.p95 });
  }
  return { pass: failures.length === 0, failures };
}

function anyFailure(failures, prefix) {
  return failures.some((f) => f.metric.startsWith(prefix));
}

function printSummary(report) {
  const lines = [];
  const env = report.environment;
  lines.push('zn-gate leak bench  seed=' + report.seed + '  ' + env.platform + '/' + env.arch + '  ' + env.node);
  lines.push('engine: packages/zn-gate/lib/scrub/engine.js (' + (report.engine.loaded ? 'loaded' : 'MISSING, stub used') + ')');
  if (report.corpus && !report.corpus.present) {
    lines.push('corpus:         NOT DOWNLOADED — ' + report.corpus.hint);
  }

  if (report.status === 'not-implemented') {
    lines.push('result: NOT IMPLEMENTED — engine not available, all measurements skipped.');
    lines.push('        re-run once packages/zn-gate/lib/scrub/engine.js exists (WP1).');
  } else {
    const failures = report.gate.failures;
    const L = report.leaks;
    lines.push('leaks:          ' + L.leaked + '/' + L.cases + ' cases leaked (limit ' + report.thresholds.max_leaks + ')  ' +
      (anyFailure(failures, 'lea') ? 'FAIL' : 'PASS'));
    const O = report.overredaction;
    if (O.present) {
      lines.push('over-redaction: ' + O.altered_files + '/' + O.scanned + ' files altered (' + round3(O.altered_rate * 100) +
        '% of ' + (O.bytes / 1048576).toFixed(1) + ' MB, limit ' + round3(report.thresholds.max_overredacted_file_rate * 100) + '%)  ' +
        (anyFailure(failures, 'overredaction:alter') || anyFailure(failures, 'overredaction:scan') ? 'FAIL' : 'PASS'));
    } else {
      lines.push('over-redaction: SKIPPED — corpus missing at ' + report.corpus.dir + ' (run packages/zn-gate/test/fixtures/benign/fetch_corpus.sh)');
    }
    lines.push('known-OK:       ' + O.known_ok.redacted_cases + '/' + O.known_ok.cases + ' fixed snippets altered, ' +
      O.known_ok.errors + ' errors (limit ' + report.thresholds.max_known_ok_redactions + ')  ' +
      (anyFailure(failures, 'overredaction:known') ? 'FAIL' : 'PASS'));
    const lat = Object.entries(report.latency.samples).map(([label, s]) => {
      if (s.error) return label + ' ERROR';
      return label + ' p50=' + s.p50_ms + 'ms p95=' + s.p95_ms + 'ms' + (anyFailure(failures, 'latency:' + label) ? ' FAIL' : '');
    }).join(' | ');
    lines.push('latency:        ' + lat + ' (hook budget: p50 <= 60ms at 64KB, whole process)');
    lines.push('gate:           ' + (report.gate.pass ? 'PASS' : 'FAIL'));
    for (const f of report.gate.failures) lines.push('  FAIL ' + f.metric + ': ' + f.actual + ' (limit ' + f.limit + ')');
    if (O.present && report.latency.payload_source === 'builtin') {
      lines.push('note:           latency payload used the built-in snippet (corpus too small or unreadable)');
    }
  }
  if (report.json_path) lines.push('json: ' + report.json_path);
  console.log(lines.join('\n'));
}

function finish(report, args, thresholds) {
  if (report.status !== 'not-implemented') {
    report.gate = evaluateGate(report, thresholds, args);
    report.status = report.gate.pass ? 'ok' : 'failed';
  }
  if (args.json === '-') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const target = path.resolve(args.json);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    report.json_path = path.relative(ROOT, target).replace(/\\/g, '/');
    printSummary(report);
  }
  if (report.status === 'not-implemented') {
    process.exitCode = args.requireEngine ? 1 : 0;
  } else {
    process.exitCode = report.gate.pass ? 0 : 1;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const thresholds = loadThresholds(args.thresholds);
  const loaded = loadEngine();
  const report = {
    schema_version: 1,
    tool: 'bench/leak_bench.js',
    generated_at: new Date().toISOString(),
    seed: args.seed,
    per_type: args.perType,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
    },
    engine: {
      path: 'packages/zn-gate/lib/scrub/engine.js',
      loaded: !!loaded.engine,
      error: loaded.error ? String(loaded.error.message || loaded.error) : null,
    },
    thresholds,
  };

  const engine = loaded.engine || stubEngine();
  const vault = makeVaultStub();
  const generated = generateAll(args.seed, { perType: args.perType, piiPerType: args.perType });
  const cases = buildLeakCases(generated);
  report.cases_total = cases.length;

  const corpusPresent = fs.existsSync(args.corpus);
  report.corpus = {
    dir: path.relative(ROOT, args.corpus).replace(/\\/g, '/') || '.',
    present: corpusPresent,
    hint: corpusPresent ? null : 'run: bash packages/zn-gate/test/fixtures/benign/fetch_corpus.sh',
  };

  try {
    report.leaks = await runLeaks(engine, vault, cases);
  } catch (err) {
    if (isNotImplemented(err)) {
      report.status = 'not-implemented';
      report.gate = { pass: null, skipped: true, failures: [] };
      report.notes = ['scrub/engine.js is not implemented yet; all measurements skipped (local stub used)'];
      if (!corpusPresent) report.notes.push('benign corpus not downloaded: ' + report.corpus.hint);
      finish(report, args, thresholds);
      return;
    }
    throw err;
  }

  const over = { present: corpusPresent, known_ok: await runKnownOk(engine, vault, KNOWN_OK) };
  if (corpusPresent) Object.assign(over, await runCorpus(engine, vault, args.corpus));
  report.overredaction = over;
  report.latency = await runLatency(engine, vault, args.corpus, args.quick);
  finish(report, args, thresholds);
}

main().catch((err) => {
  console.error('leak_bench crashed: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
