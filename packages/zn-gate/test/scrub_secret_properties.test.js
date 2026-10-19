'use strict';
/**
 * Property tests (fast-check) against false negatives of the secret scrubber.
 *
 * For each provider key format that the scrubber covers (the PATTERNS table
 * in lib/scrub/patterns.js), the generators below produce random keys with
 * the public prefix and length of that format. The random body is marked
 * with an obvious fake marker (FAKE, or 0000 in hex bodies) at a random
 * offset wherever the format allows it. Each key is embedded in free text,
 * a JSON value, a .env line and, for URL-safe formats, a URL query string and
 * a URL userinfo.
 *
 * The property: the engine (scan, pattern and PII layers) must cover the key
 * with a span, the redacted text must not contain the key anymore, and the
 * text around the key must stay as it was.
 *
 * Bodies are filtered for randomness with a bar stricter than each rule's own
 * check, so the generated values are clearly random and never placeholders.
 * Nothing here is a credential: prefixes are public and the bodies are
 * random and marked as fake.
 *
 * Deliberately not generated: AWS key ids ending in EXAMPLE (the rule
 * exempts the AWS documentation example key), PEM blocks, Azure AD client
 * secrets, Discord bot tokens and database passwords. Each has its own
 * structure and its own tests.
 *
 * The PROVIDERS table is the single place to edit. The Python port of these
 * tests keeps the same table shape.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const E = require('../lib/scrub/engine');

const SEED = 20261018;
const RUNS = 40;

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEX = '0123456789abcdef';
const DIGITS = '0123456789';
const URL_SAFE = ALNUM + '-_';
const BASE64 = ALNUM + '+/';

// Quality bars for generated bodies: character classes present and Shannon
// entropy in bits per character.
const Q = {
  alnum: { classes: 3, bits: 3.5 },
  loose: { classes: 2, bits: 3.3 },
  hex: { classes: 2, bits: 3.0 },
  upper: { classes: 2, bits: 2.5 },
  digits: { classes: 1, bits: 0 },
};

function classCount(s) {
  return [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(s)).length;
}

function shannon(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksRandom(s, q) {
  return classCount(s) >= q.classes && shannon(s) >= q.bits;
}

/* A body of `len` characters over `alphabet`, with `marker` at a random
 * offset (an empty marker gives a plain random body). */
function body(len, alphabet, marker, q) {
  const chars = [...alphabet];
  const rest = len - marker.length;
  return fc
    .tuple(
      fc.integer({ min: 0, max: rest }),
      fc.array(fc.constantFrom(...chars), { minLength: rest, maxLength: rest }),
    )
    .map(([at, cs]) => {
      const s = cs.join('');
      return s.slice(0, at) + marker + s.slice(at);
    })
    .filter((s) => looksRandom(s, q));
}

const pick = (...xs) => fc.constantFrom(...xs);
const cat = (...parts) =>
  fc
    .tuple(...parts.map((p) => (typeof p === 'string' ? fc.constant(p) : p)))
    .map((xs) => xs.join(''));

/* Each entry: a name, the scrubber type it must map to (documentation only),
 * a generator of secret values, and whether the value is URL-safe enough for
 * the URL contexts. `keep` is a label in front of the value (Azure
 * `AccountKey=`): the value must be redacted, the label may or may not stay. */
const PROVIDERS = [
  { name: 'AWS access key id', type: 'AWS_KEY', url: true,
    gen: cat(pick('AKIA', 'ASIA'), body(16, UPPER_DIGITS, 'FAKE', Q.upper)) },
  { name: 'GitHub token (ghp, gho, ghu, ghs, ghr)', type: 'GITHUB_TOKEN', url: true,
    gen: cat(pick('ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'), body(36, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'GitHub fine-grained token', type: 'GITHUB_PAT', url: true,
    gen: cat('github_pat_', body(22, ALNUM, 'FAKE', Q.alnum), '_', body(59, ALNUM, '', Q.alnum)) },
  { name: 'GitLab token', type: 'GITLAB_TOKEN', url: true,
    gen: cat('glpat-', body(20, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Slack token (xoxb, xoxp)', type: 'SLACK_TOKEN', url: true,
    gen: cat(pick('xoxb-', 'xoxp-'), body(10, DIGITS, '0000', Q.digits), '-',
      body(12, DIGITS, '', Q.digits), '-', body(24, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Stripe secret or restricted key (test and live)', type: 'STRIPE_KEY', url: true,
    gen: cat(pick('sk_test_', 'sk_live_', 'rk_test_', 'rk_live_'), body(24, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Stripe webhook secret', type: 'STRIPE_WEBHOOK_SECRET', url: true,
    gen: cat('whsec_', body(40, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'OpenAI project key', type: 'OPENAI_KEY', url: true,
    gen: cat('sk-proj-', body(48, URL_SAFE, 'FAKE', Q.alnum)) },
  { name: 'OpenAI legacy key', type: 'OPENAI_KEY', url: true,
    gen: cat('sk-', body(48, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'OpenAI hex key (sk- and 32 hex)', type: 'OPENAI_KEY', url: true,
    gen: cat('sk-', body(32, HEX, '0000', Q.hex)) },
  { name: 'Anthropic key', type: 'ANTHROPIC_KEY', url: true,
    gen: cat('sk-ant-', pick('api03-', 'admin01-'), body(93, URL_SAFE, 'FAKE', Q.alnum)) },
  { name: 'Google API key', type: 'GOOGLE_API_KEY', url: true,
    gen: cat('AIza', body(35, URL_SAFE, 'FAKE', Q.alnum)) },
  { name: 'Google OAuth client secret', type: 'GOOGLE_OAUTH_SECRET', url: true,
    gen: cat('GOCSPX-', body(28, URL_SAFE, 'FAKE', Q.alnum)) },
  { name: 'Hugging Face token', type: 'HF_TOKEN', url: true,
    gen: cat('hf_', body(34, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'npm token', type: 'NPM_TOKEN', url: true,
    gen: cat('npm_', body(36, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'PyPI token', type: 'PYPI_TOKEN', url: true,
    gen: cat('pypi-AgE', body(60, URL_SAFE, 'FAKE', Q.alnum)) },
  { name: 'SendGrid key', type: 'SENDGRID_KEY', url: true,
    gen: cat('SG.', body(22, URL_SAFE, 'FAKE', Q.alnum), '.', body(43, URL_SAFE, '', Q.alnum)) },
  { name: 'Twilio API key SID', type: 'TWILIO_KEY', url: true,
    gen: cat('SK', body(32, HEX, '0000', Q.hex)) },
  { name: 'Mailgun key', type: 'MAILGUN_KEY', url: true,
    gen: cat('key-', body(32, HEX, '0000', Q.hex)) },
  { name: 'Shopify token', type: 'SHOPIFY_TOKEN', url: true,
    gen: cat(pick('shpat_', 'shpca_', 'shppa_', 'shpss_'), body(32, HEX, '0000', Q.hex)) },
  { name: 'DigitalOcean token', type: 'DIGITALOCEAN_TOKEN', url: true,
    gen: cat(pick('dop_v1_', 'doo_v1_', 'dor_v1_'), body(64, HEX, '0000', Q.hex)) },
  { name: 'Linear key', type: 'LINEAR_KEY', url: true,
    gen: cat('lin_api_', body(40, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Databricks token', type: 'DATABRICKS_TOKEN', url: true,
    gen: cat('dapi', body(32, HEX, '0000', Q.hex)) },
  { name: 'HashiCorp Vault token', type: 'VAULT_TOKEN', url: true,
    gen: cat(pick('hvs.', 'hvb.'), body(32, URL_SAFE, 'FAKE', Q.alnum)) },
  { name: 'Groq key', type: 'GROQ_KEY', url: true,
    gen: cat('gsk_', body(52, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'xAI key', type: 'XAI_KEY', url: true,
    gen: cat('xai-', body(80, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'New Relic key', type: 'NEWRELIC_KEY', url: true,
    gen: cat(pick('NRAK-', 'NRII-'), body(27, UPPER_DIGITS, 'FAKE', Q.upper)) },
  { name: 'Docker Hub token', type: 'DOCKERHUB_PAT', url: true,
    gen: cat(pick('dckr_pat_', 'dckr_oat_'), body(27, URL_SAFE, 'FAKE', Q.loose)) },
  { name: 'zn API key', type: 'ZN_API_KEY', url: true,
    gen: cat('zn_', body(48, HEX, '0000', Q.hex)) },
  { name: 'Tavily key', type: 'TAVILY_KEY', url: true,
    gen: cat('tvly-', body(32, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Firecrawl key', type: 'FIRECRAWL_KEY', url: true,
    gen: cat('fc-', body(32, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Polar token', type: 'POLAR_TOKEN', url: true,
    gen: cat('polar_oat_', body(32, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Replicate token', type: 'REPLICATE_TOKEN', url: true,
    gen: cat('r8_', body(37, ALNUM, 'FAKE', Q.loose)) },
  { name: 'Supabase token', type: 'SUPABASE_PAT', url: true,
    gen: cat('sbp_', body(40, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Square access token', type: 'SQUARE_TOKEN', url: true,
    gen: cat('EAAA', body(60, URL_SAFE, 'FAKE', Q.loose)) },
  { name: 'Telegram bot token', type: 'TELEGRAM_BOT_TOKEN', url: true,
    gen: cat(body(10, DIGITS, '0000', Q.digits), ':AA', body(33, URL_SAFE, 'FAKE', Q.alnum)) },
  { name: 'Azure storage account key', type: 'AZURE_STORAGE_KEY', url: false,
    keep: 'AccountKey=', gen: cat(body(86, BASE64, 'FAKE', Q.alnum), '==') },
  { name: 'JSON Web Token', type: 'JWT', url: true,
    gen: cat('eyJ', body(20, URL_SAFE, '', Q.alnum), '.eyJ', body(24, URL_SAFE, '', Q.alnum), '.',
      body(43, URL_SAFE, 'FAKE', Q.alnum)) },
  { name: 'Slack webhook URL', type: 'SLACK_WEBHOOK', url: false,
    gen: cat('https://hooks.slack.com/services/T0000/B0000/', body(24, ALNUM, 'FAKE', Q.alnum)) },
  { name: 'Discord webhook URL', type: 'DISCORD_WEBHOOK', url: false,
    gen: cat('https://discord.com/api/webhooks/', body(18, DIGITS, '0000', Q.digits), '/',
      body(68, URL_SAFE, 'FAKE', Q.alnum)) },
];

/* Surrounding text for each context. `url` contexts only run for URL-safe
 * formats. */
const CONTEXTS = [
  { name: 'free text', pre: 'Please rotate this value now: ', post: ' before Friday.' },
  { name: 'JSON value', pre: '{"name": "ci", "token": "', post: '", "retries": 3}' },
  { name: '.env line', pre: 'DEBUG=1\nLOG_LEVEL=info\nSERVICE_TOKEN=', post: '\nREGION=eu-west-1\n' },
  { name: 'URL query string', pre: 'https://api.example.test/v1/items?page=2&api_key=', post: '&sort=asc', url: true },
  { name: 'URL userinfo', pre: 'https://svc-bot:', post: '@git.example.test/org/repo.git', url: true },
];

/* Replaces each span by a marker and keeps the rest of the text. */
function redact(text, spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue;
    out += text.slice(pos, s.start) + '[REDACTED]';
    pos = s.end;
  }
  return out + text.slice(pos);
}

function assertRedacted(pre, keep, key, post) {
  const text = pre + keep + key + post;
  const spans = E.scan(text, { pii: false });
  const start = pre.length + keep.length;
  const end = start + key.length;
  assert.ok(spans.some((s) => s.start <= start && s.end >= end), 'secret value not covered by a span');
  const out = redact(text, spans);
  assert.ok(!out.includes(key), 'secret value survives redaction: ' + JSON.stringify(out));
  assert.ok(out.startsWith(pre) && out.endsWith(post), 'surrounding text changed: ' + JSON.stringify(out));
}

for (const p of PROVIDERS) {
  const contexts = CONTEXTS.filter((c) => !c.url || p.url);
  test(`${p.name} (${p.type}): redacted in ${contexts.map((c) => c.name).join(', ')}`, () => {
    fc.assert(
      fc.property(p.gen, (key) => {
        for (const c of contexts) assertRedacted(c.pre, p.keep || '', key, c.post);
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });
}
