'use strict';
/**
 * Deterministic generator of FAKE secrets and synthetic PII for the zn-gate
 * leak bench.
 *
 * Everything produced here is fabricated: secret bodies come from a seeded
 * PRNG (mulberry32) and only reuse public format prefixes (sk-ant-, AKIA,
 * ghp_, glpat-, xoxb-, ...). No value is a real credential and none can
 * authenticate against anything. PII is synthetic: emails use the reserved
 * example.org domain, phones use fiction ranges (+1 555-01XX, +44 7700
 * 900XXX), IBANs are random DE BBANs with a valid mod-97 checksum, cards
 * start from published test BINs and pass Luhn, DNI/NIE carry a valid
 * control letter.
 *
 * Determinism: same seed -> byte-identical output on every Node version.
 *
 * CLI:  node fake_secrets.js [--seed N] [--per-type N] [--json]
 *                             [--summary] [--selftest]
 *   --selftest  runnable self-check (determinism, formats, checksums)
 *   --json      print the full generated set as JSON
 *   --summary   print per-type counts (default)
 */

const SEED_DEFAULT = 1337005;

/* Deterministic PRNG (mulberry32). Math.imul is exact, so the stream is
 * identical on every JS engine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = {
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  hex: '0123456789abcdef',
  b64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  b64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  urlsafe: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
};

function pick(rnd, chars, n) {
  let out = '';
  for (let i = 0; i < n; i++) out += chars[Math.floor(rnd() * chars.length)];
  return out;
}

function digits(rnd, n) {
  return pick(rnd, CHARS.digits, n);
}

function int(rnd, min, max) {
  return min + Math.floor(rnd() * (max - min + 1));
}

/* Checksums (exported: bench and tests verify with the same primitives). */

function luhnCheckDigit(partial) {
  let sum = 0;
  let double = true;
  for (let i = partial.length - 1; i >= 0; i--) {
    let d = partial.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return String((10 - (sum % 10)) % 10);
}

function luhnValid(number) {
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let d = number.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function mod97(value) {
  let rem = 0;
  for (const ch of value) {
    const expanded = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of expanded) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem;
}

function ibanCheckDigits(countryCode, bban) {
  return String(98 - mod97(bban + countryCode + '00')).padStart(2, '0');
}

function ibanValid(iban) {
  const clean = String(iban).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(clean)) return false;
  return mod97(clean.slice(4) + clean.slice(0, 4)) === 1;
}

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/* Secret generators: each returns { value, sensitive }, where `sensitive`
 * is the substring that must never survive tokenization (connection
 * strings: only the password; everything else: the whole value). */

const TEST_CARD_PREFIXES = ['424242', '400005', '555555', '520082', '601111', '378282'];

function pemText(rnd, label, lines) {
  const body = [];
  for (let i = 0; i < lines; i++) body.push(pick(rnd, CHARS.b64, 64));
  return '-----BEGIN ' + label + '-----\n' + body.join('\n') + '\n-----END ' + label + '-----\n';
}

function jwtToken(rnd) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: 'svc-' + pick(rnd, CHARS.lower + CHARS.digits, 10),
    iss: 'https://auth.example.org',
    exp: 4102444800,
  })).toString('base64url');
  return { value: header + '.' + payload + '.' + pick(rnd, CHARS.b64url, 43) };
}

function connectionString(rnd, scheme, host, port, pathPart) {
  const password = pick(rnd, CHARS.urlsafe, 24);
  const userinfo = scheme === 'redis' ? ':' + password : 'app_rw:' + password;
  return { value: scheme + '://' + userinfo + '@' + host + ':' + port + '/' + pathPart, sensitive: password };
}

const SECRET_GENERATORS = [
  ['anthropic_api_key', (r) => ({ value: 'sk-ant-api03-' + pick(r, CHARS.b64url, 95) })],
  ['openai_project_key', (r) => ({ value: 'sk-proj-' + pick(r, CHARS.urlsafe, 74) })],
  ['openai_api_key', (r) => ({ value: 'sk-' + pick(r, CHARS.urlsafe, 48) })],
  ['aws_access_key_id', (r) => ({ value: 'AKIA' + pick(r, CHARS.upper + CHARS.digits, 16) })],
  ['aws_session_key_id', (r) => ({ value: 'ASIA' + pick(r, CHARS.upper + CHARS.digits, 16) })],
  ['aws_secret_access_key', (r) => ({ value: pick(r, CHARS.b64, 40) })],
  ['github_pat_classic', (r) => ({ value: 'ghp_' + pick(r, CHARS.alnum, 36) })],
  ['github_oauth_token', (r) => ({ value: 'gho_' + pick(r, CHARS.alnum, 36) })],
  ['github_app_token', (r) => ({ value: 'ghs_' + pick(r, CHARS.alnum, 36) })],
  ['github_fine_grained_pat', (r) => ({ value: 'github_pat_' + pick(r, CHARS.alnum, 22) + '_' + pick(r, CHARS.alnum, 59) })],
  ['gitlab_pat', (r) => ({ value: 'glpat-' + pick(r, CHARS.alnum, 20) })],
  ['slack_bot_token', (r) => ({ value: 'xoxb-' + digits(r, 12) + '-' + digits(r, 12) + '-' + pick(r, CHARS.alnum, 24) })],
  ['slack_user_token', (r) => ({ value: 'xoxp-' + digits(r, 12) + '-' + digits(r, 12) + '-' + pick(r, CHARS.alnum, 24) })],
  ['slack_app_token', (r) => ({ value: 'xoxa-' + digits(r, 12) + '-' + digits(r, 12) + '-' + pick(r, CHARS.alnum, 24) })],
  ['slack_refresh_token', (r) => ({ value: 'xoxr-' + digits(r, 12) + '-' + digits(r, 12) + '-' + pick(r, CHARS.alnum, 24) })],
  ['slack_socket_token', (r) => ({ value: 'xoxs-' + digits(r, 12) + '-' + digits(r, 12) + '-' + pick(r, CHARS.alnum, 24) })],
  ['stripe_live_secret_key', (r) => ({ value: 'sk_live_' + pick(r, CHARS.alnum, 32) })],
  ['stripe_live_restricted_key', (r) => ({ value: 'rk_live_' + pick(r, CHARS.alnum, 32) })],
  ['google_api_key', (r) => ({ value: 'AIza' + pick(r, CHARS.urlsafe, 35) })],
  ['huggingface_token', (r) => ({ value: 'hf_' + pick(r, CHARS.alnum, 34) })],
  ['npm_access_token', (r) => ({ value: 'npm_' + pick(r, CHARS.alnum, 36) })],
  ['sendgrid_api_key', (r) => ({ value: 'SG.' + pick(r, CHARS.urlsafe, 22) + '.' + pick(r, CHARS.urlsafe, 43) })],
  ['jwt', jwtToken],
  ['rsa_private_key', (r) => ({ value: pemText(r, 'RSA PRIVATE KEY', 26) })],
  ['ec_private_key', (r) => ({ value: pemText(r, 'EC PRIVATE KEY', 10) })],
  ['openssh_private_key', (r) => ({ value: pemText(r, 'OPENSSH PRIVATE KEY', 18) })],
  ['postgres_connection_string', (r) => connectionString(r, 'postgres', 'db.internal', 5432, 'appdb')],
  ['mysql_connection_string', (r) => connectionString(r, 'mysql', 'db.internal', 3306, 'appdb')],
  ['mongodb_connection_string', (r) => connectionString(r, 'mongodb', 'mongo.internal', 27017, 'appdb')],
  ['redis_connection_string', (r) => connectionString(r, 'redis', 'cache.internal', 6379, '0')],
];

const SECRET_TYPES = SECRET_GENERATORS.map((g) => g[0]);

const PII_GENERATORS = [
  ['email', (r) => ({ value: pick(r, CHARS.lower, 6) + '.' + pick(r, CHARS.lower, 6) + '@example.org' })],
  ['phone_e164', (r) => (r() < 0.5
    ? { value: '+1' + String(int(r, 2, 9)) + digits(r, 2) + '55501' + digits(r, 2) }
    : { value: '+447700900' + digits(r, 3) })],
  ['iban', (r) => {
    const bban = digits(r, 8) + digits(r, 10);
    return { value: 'DE' + ibanCheckDigits('DE', bban) + bban };
  }],
  ['payment_card', (r) => {
    const prefix = TEST_CARD_PREFIXES[int(r, 0, TEST_CARD_PREFIXES.length - 1)];
    const length = prefix === '378282' ? 15 : 16;
    const body = prefix + digits(r, length - prefix.length - 1);
    return { value: body + luhnCheckDigit(body) };
  }],
  ['dni', (r) => {
    const n = int(r, 10000000, 99999999);
    return { value: String(n) + DNI_LETTERS[n % 23] };
  }],
  ['nie', (r) => {
    const letter = 'XYZ'[int(r, 0, 2)];
    const seven = digits(r, 7);
    const n = 'XYZ'.indexOf(letter) * 10000000 + parseInt(seven, 10);
    return { value: letter + seven + DNI_LETTERS[n % 23] };
  }],
];

const PII_TYPES = PII_GENERATORS.map((g) => g[0]);

/* Deterministic batch: entries come from a single PRNG stream in a fixed
 * order (sample index outer, type inner), so output is stable across runs. */
function generateAll(seed = SEED_DEFAULT, opts = {}) {
  const perType = opts.perType || 1;
  const piiPerType = opts.piiPerType || 1;
  const rnd = mulberry32(seed);
  const secrets = [];
  const pii = [];
  for (let i = 0; i < perType; i++) {
    for (const [type, gen] of SECRET_GENERATORS) {
      const made = gen(rnd);
      secrets.push({ type, value: made.value, sensitive: made.sensitive || made.value });
    }
  }
  for (let i = 0; i < piiPerType; i++) {
    for (const [type, gen] of PII_GENERATORS) {
      const made = gen(rnd);
      pii.push({ type, value: made.value, sensitive: made.sensitive || made.value });
    }
  }
  return { seed, secrets, pii };
}

/* Format validators, one per type. Used by the selftest, the unit tests
 * and (optionally) by consumers that need to assert fixture shape. */
const VALIDATORS = {
  anthropic_api_key: (v) => /^sk-ant-api03-[A-Za-z0-9_-]{90,100}$/.test(v),
  openai_project_key: (v) => /^sk-proj-[A-Za-z0-9_-]{40,}$/.test(v),
  openai_api_key: (v) => /^sk-(?!ant-|proj-)[A-Za-z0-9_-]{40,}$/.test(v),
  aws_access_key_id: (v) => /^AKIA[A-Z0-9]{16}$/.test(v),
  aws_session_key_id: (v) => /^ASIA[A-Z0-9]{16}$/.test(v),
  aws_secret_access_key: (v) => /^[A-Za-z0-9+/]{40}$/.test(v),
  github_pat_classic: (v) => /^ghp_[A-Za-z0-9]{36}$/.test(v),
  github_oauth_token: (v) => /^gho_[A-Za-z0-9]{36}$/.test(v),
  github_app_token: (v) => /^ghs_[A-Za-z0-9]{36}$/.test(v),
  github_fine_grained_pat: (v) => /^github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}$/.test(v),
  gitlab_pat: (v) => /^glpat-[A-Za-z0-9]{20}$/.test(v),
  slack_bot_token: (v) => /^xoxb-\d{12}-\d{12}-[A-Za-z0-9]{24}$/.test(v),
  slack_user_token: (v) => /^xoxp-\d{12}-\d{12}-[A-Za-z0-9]{24}$/.test(v),
  slack_app_token: (v) => /^xoxa-\d{12}-\d{12}-[A-Za-z0-9]{24}$/.test(v),
  slack_refresh_token: (v) => /^xoxr-\d{12}-\d{12}-[A-Za-z0-9]{24}$/.test(v),
  slack_socket_token: (v) => /^xoxs-\d{12}-\d{12}-[A-Za-z0-9]{24}$/.test(v),
  stripe_live_secret_key: (v) => /^sk_live_[A-Za-z0-9]{32}$/.test(v),
  stripe_live_restricted_key: (v) => /^rk_live_[A-Za-z0-9]{32}$/.test(v),
  google_api_key: (v) => /^AIza[A-Za-z0-9_-]{35}$/.test(v),
  huggingface_token: (v) => /^hf_[A-Za-z0-9]{34}$/.test(v),
  npm_access_token: (v) => /^npm_[A-Za-z0-9]{36}$/.test(v),
  sendgrid_api_key: (v) => /^SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(v),
  jwt: (v) => {
    const parts = v.split('.');
    if (parts.length !== 3) return false;
    try {
      return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')).alg === 'HS256';
    } catch (err) {
      return false;
    }
  },
  rsa_private_key: (v) => /^-----BEGIN RSA PRIVATE KEY-----\n([A-Za-z0-9+/]{64}\n){26}-----END RSA PRIVATE KEY-----\n$/.test(v),
  ec_private_key: (v) => /^-----BEGIN EC PRIVATE KEY-----\n([A-Za-z0-9+/]{64}\n){10}-----END EC PRIVATE KEY-----\n$/.test(v),
  openssh_private_key: (v) => /^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/]{64}\n){18}-----END OPENSSH PRIVATE KEY-----\n$/.test(v),
  postgres_connection_string: (v) => /^postgres:\/\/app_rw:[A-Za-z0-9_-]{24}@db\.internal:5432\/appdb$/.test(v),
  mysql_connection_string: (v) => /^mysql:\/\/app_rw:[A-Za-z0-9_-]{24}@db\.internal:3306\/appdb$/.test(v),
  mongodb_connection_string: (v) => /^mongodb:\/\/app_rw:[A-Za-z0-9_-]{24}@mongo\.internal:27017\/appdb$/.test(v),
  redis_connection_string: (v) => /^redis:\/\/:[A-Za-z0-9_-]{24}@cache\.internal:6379\/0$/.test(v),
  email: (v) => /^[a-z]{6}\.[a-z]{6}@example\.org$/.test(v),
  phone_e164: (v) => /^(\+1[2-9]\d{2}55501\d{2}|\+447700900\d{3})$/.test(v),
  iban: (v) => /^DE\d{20}$/.test(v) && ibanValid(v),
  payment_card: (v) => luhnValid(v) && /^(424242\d{10}|400005\d{10}|555555\d{10}|520082\d{10}|601111\d{10}|378282\d{9})$/.test(v),
  dni: (v) => /^\d{8}[A-Z]$/.test(v) && v[8] === DNI_LETTERS[Number(v.slice(0, 8)) % 23],
  nie: (v) => {
    const m = /^([XYZ])(\d{7})([A-Z])$/.exec(v);
    if (!m) return false;
    const n = 'XYZ'.indexOf(m[1]) * 10000000 + parseInt(m[2], 10);
    return m[3] === DNI_LETTERS[n % 23];
  },
};

function validate(entry) {
  const fn = VALIDATORS[entry.type];
  if (!fn) return 'unknown type: ' + entry.type;
  if (!fn(entry.value)) return 'value does not match format for ' + entry.type;
  if (entry.sensitive && !entry.value.includes(entry.sensitive)) return 'sensitive is not part of value';
  if (entry.sensitive && entry.sensitive.length < 8) return 'sensitive shorter than 8 chars';
  return null;
}

/* Runnable self-check: run `node fake_secrets.js --selftest`. */
function selftest() {
  const failures = [];
  const check = (name, cond) => { if (!cond) failures.push(name); };

  const a = generateAll(SEED_DEFAULT, { perType: 2, piiPerType: 2 });
  const b = generateAll(SEED_DEFAULT, { perType: 2, piiPerType: 2 });
  check('determinism: same seed, identical JSON', JSON.stringify(a) === JSON.stringify(b));
  check('different seed, different output', JSON.stringify(generateAll(SEED_DEFAULT + 1)) !== JSON.stringify(generateAll(SEED_DEFAULT)));
  check('30 secret types', SECRET_TYPES.length === 30);
  check('6 PII types', PII_TYPES.length === 6);

  for (const entry of [...a.secrets, ...a.pii]) {
    const err = validate(entry);
    check('validate ' + entry.type + ' (' + entry.value.slice(0, 14) + '...)', err === null);
  }

  const seen = new Set();
  for (const entry of [...a.secrets, ...a.pii]) {
    const key = entry.type + ':' + entry.value;
    check('unique ' + key.slice(0, 40) + '...', !seen.has(key));
    seen.add(key);
  }

  check('luhn: known valid Visa test number', luhnValid('4242424242424242'));
  check('luhn: known valid Amex test number', luhnValid('378282246310005'));
  check('luhn: detects mutation', !luhnValid('4242424242424241'));
  check('dni: known vector 12345678Z', validate({ type: 'dni', value: '12345678Z' }) === null);
  check('dni: rejects wrong control letter', validate({ type: 'dni', value: '12345678A' }) !== null);
  check('nie: known vector X0000000T', validate({ type: 'nie', value: 'X0000000T' }) === null);
  check('nie: rejects wrong control letter', validate({ type: 'nie', value: 'X0000000A' }) !== null);
  check('phone: E.164 fiction sample accepted', validate({ type: 'phone_e164', value: '+12025550142' }) === null);
  check('phone: too-short US number rejected', validate({ type: 'phone_e164', value: '+15550142' }) !== null);

  const iban = a.pii.find((p) => p.type === 'iban').value;
  check('iban: generated passes mod-97', ibanValid(iban));
  const mutated = iban.slice(0, -1) + String((Number(iban.slice(-1)) + 1) % 10);
  check('iban: mutated fails mod-97', !ibanValid(mutated));

  const jwt = a.secrets.find((s) => s.type === 'jwt').value;
  check('jwt: three dot-separated parts', jwt.split('.').length === 3);

  if (failures.length > 0) {
    console.error('FAIL fake_secrets selftest (' + failures.length + ' failures):');
    for (const f of failures) console.error('  - ' + f);
    return 1;
  }
  console.log('OK fake_secrets selftest: ' + SECRET_TYPES.length + ' secret types, ' + PII_TYPES.length +
    ' PII types, checksums and determinism verified');
  return 0;
}

function printHelp() {
  console.log('Usage: node fake_secrets.js [--selftest] [--json] [--summary] [--seed N] [--per-type N]');
}

function main(argv) {
  const args = { seed: SEED_DEFAULT, perType: 1, piiPerType: 1, mode: 'summary' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') args.mode = 'selftest';
    else if (a === '--json') args.mode = 'json';
    else if (a === '--summary') args.mode = 'summary';
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--per-type') { args.perType = Number(argv[++i]); args.piiPerType = args.perType; }
    else if (a === '--help' || a === '-h') { printHelp(); return 0; }
    else { console.error('unknown argument: ' + a); printHelp(); return 2; }
  }
  if (args.mode === 'selftest') return selftest();
  const data = generateAll(args.seed, { perType: args.perType, piiPerType: args.piiPerType });
  if (args.mode === 'json') {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  console.log('fake_secrets seed=' + args.seed + ' secrets=' + data.secrets.length + ' pii=' + data.pii.length + ' (deterministic)');
  console.log('secret types: ' + SECRET_TYPES.join(', '));
  console.log('pii types: ' + PII_TYPES.join(', '));
  console.log('use --json to print values, --selftest to verify formats and checksums');
  return 0;
}

module.exports = {
  SEED_DEFAULT,
  SECRET_TYPES,
  PII_TYPES,
  generateAll,
  validate,
  luhnValid,
  luhnCheckDigit,
  ibanValid,
  ibanCheckDigits,
  mulberry32,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
