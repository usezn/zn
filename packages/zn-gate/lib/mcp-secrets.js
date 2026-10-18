'use strict';
/**
 * Plaintext credentials in MCP server configuration files.
 *
 *   isMcpConfigPath(file)            whether a file is an MCP configuration
 *   findMcpConfigSecrets(text)       [{ line, kind, name }] (1-based lines)
 *   mcpNextStep(kind, name)          what to do about one, in plain words
 *   mcpSample(kind, name)            the text shown for it (never the value)
 *
 * The check works on lines, so JSON, JSON with comments and TOML are read the
 * same way and a file with a syntax error is still checked. It looks at the
 * three places an MCP server gets a credential: a value under a name that ends
 * in a secret word (`"BRAVE_API_KEY": "..."`, `Authorization = "Bearer ..."`),
 * a credential flag in the arguments (`"--api-key=..."`, or the flag and its
 * value as two items, maybe on two lines), and a key in a URL
 * (`https://host/mcp?api_key=...`). A reference (`${NAME}`, `$NAME`,
 * `%NAME%`, `__ZN_NAME__`), a placeholder, a path and a value that reads as
 * ordinary text are not credentials (the same judgement the scan already
 * applies to `NAME=value`). The value is never part of a result: only its
 * kind, the name that holds it and the line.
 *
 * The same rules are in packages/zn-gate-py/src/zn_gate/mcp_secrets.py; the
 * shared samples in test/fixtures/mcp_config_secret_samples.json keep the two
 * in step.
 */

const { isNonSecretValue } = require('./rules');

const RULE_ID = 'secret:mcp_config';

// Files that hold MCP servers: by name (any folder) or by folder and name.
const MCP_FILE_NAMES = new Set([
  '.mcp.json', 'mcp.json', 'mcp_config.json', 'mcp_settings.json', 'cline_mcp_settings.json',
  'claude_desktop_config.json', '.claude.json', 'opencode.json', 'opencode.jsonc',
]);
const MCP_FILE_IN_DIR = [['.codex', 'config.toml'], ['.gemini', 'settings.json']];

function isMcpConfigPath(file) {
  const parts = String(file).split(/[\\/]/);
  const base = (parts[parts.length - 1] || '').toLowerCase();
  if (MCP_FILE_NAMES.has(base)) return true;
  const dir = (parts[parts.length - 2] || '').toLowerCase();
  return MCP_FILE_IN_DIR.some(([d, f]) => d === dir && f === base);
}

// A name is lower-cased, camelCase is split and every other run of characters
// becomes "_": apiKey -> api_key, X-Api-Key -> x_api_key.
function normalizeName(name) {
  return String(name).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

const SECRET_NAME = /(?:^|_)(?:token|secret|pwd|passphrase|api_?key|access_?key|private_?key|secret_?key|auth_?key|auth|credentials?|bearer|pat)$|passw(?:or)?d$/;
// "..._key" names are credentials unless the word before says it is a public
// or lookup key.
const KEY_NAME = /_key$/;
const NOT_A_CREDENTIAL_KEY = /(?:^|_)(?:public|pub|primary|foreign|sort|cache|partition|hash|shard|route|lookup|translation|object|storage|ssh)_key$/;
// Header names that carry a credential whatever they are called.
const HEADER_NAMES = new Set(['authorization', 'proxy_authorization', 'x_api_key', 'x_auth_token', 'x_access_token', 'cookie']);
// Words that only say what kind of credential a name holds, not what it is for.
const GENERIC_WORDS = new Set(['x', 'access', 'api', 'auth', 'authorization', 'bearer', 'client', 'cookie', 'credential', 'credentials', 'key', 'pat', 'password', 'private', 'proxy', 'secret', 'session', 'token', 'user']);
// Values that name a mechanism, not a credential.
const NOT_VALUES = /^(?:true|false|null|none|oauth2?|basic|bearer|required|optional|env|file|keychain|disabled|enabled)$/i;
// A reference to a value kept elsewhere: ${VAR}, ${env:VAR}, $VAR, $(command), %VAR%, {{VAR}}, {env:VAR}, {file:path}, __ZN_NAME__, <placeholder>.
const REFERENCE = /\$\{|\$\(|\$[A-Za-z_]|%[A-Za-z_][A-Za-z0-9_]*%|\{\{|\{(?:env|file):|__ZN_[A-Za-z0-9_]+__|^<|\[REDACTED/;
const SCHEME = /^(?:bearer|basic|token)[ \t]+/i;
const MIN_VALUE = 6;

function isSecretName(norm) {
  if (!norm) return false;
  if (HEADER_NAMES.has(norm) || SECRET_NAME.test(norm)) return true;
  return KEY_NAME.test(norm) && norm !== 'key' && !NOT_A_CREDENTIAL_KEY.test(norm);
}

/** Whether a string value, found under a credential name or flag, holds a credential. */
function holdsCredential(value, withScheme) {
  let v = String(value).trim();
  if (withScheme) v = v.replace(SCHEME, '');
  if (v.length < MIN_VALUE || REFERENCE.test(v) || NOT_VALUES.test(v)) return false;
  return !isNonSecretValue(v);
}

// Tokens of one line: quoted strings (JSON, TOML basic and literal) and bare
// TOML keys. Each knows whether a ":" or "=" follows it and where the next
// token starts, so "key": "value" and key = "value" are pairs and a string with
// neither is an array item.
function tokenize(line) {
  const out = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    const c = line[i];
    let tok = null;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && line[j] !== c) j += (c === '"' && line[j] === '\\') ? 2 : 1;
      if (j >= n) break; // unterminated: nothing more on this line is a string
      tok = { str: true, text: line.slice(i + 1, j), start: i, end: j + 1 };
    } else if (/[A-Za-z0-9_]/.test(c) && (i === 0 || !/[A-Za-z0-9_.-]/.test(line[i - 1]))) {
      let j = i;
      while (j < n && j - i < 80 && /[A-Za-z0-9_.-]/.test(line[j])) j++;
      tok = { str: false, text: line.slice(i, j), start: i, end: j };
      if (j < n && /[A-Za-z0-9_.-]/.test(line[j])) { i = j; continue; } // too long to be a key
    } else {
      i++;
      continue;
    }
    // Separator after the token.
    let k = tok.end;
    while (k < n && (line[k] === ' ' || line[k] === '	')) k++;
    const sepChar = k < n && (line[k] === ':' || (line[k] === '=' && line[k + 1] !== '=')) ? line[k] : '';
    tok.sep = sepChar !== '';
    if (tok.sep) {
      k++;
      while (k < n && (line[k] === ' ' || line[k] === '	')) k++;
      tok.valueAt = k;
    }
    // A bare word is a key only when "=" follows it (TOML).
    if (!tok.str && sepChar !== '=') {
      i = tok.end;
      continue;
    }
    out.push(tok);
    i = tok.end;
  }
  return out;
}

const FLAG = /^--?[A-Za-z][A-Za-z0-9_-]{0,60}$/;
const FLAG_EQ = /^(--?[A-Za-z][A-Za-z0-9_-]{0,60})=([\s\S]*)$/;
const HEADER_ARG = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token|cookie)[ \t]*:[ \t]*([\s\S]*)$/i;
const URL_START = /^[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\//;
const QUERY_PARAM = /[?&;#]([A-Za-z0-9_.-]{1,60})=([^&#\s]*)/g;
const SCHEME_VALUE = /^(?:bearer|basic)[ \t]+\S/i;

function urlParamNames(text) {
  const names = [];
  if (!URL_START.test(text) || (!text.includes('?') && !text.includes('#') && !text.includes(';'))) return names;
  QUERY_PARAM.lastIndex = 0;
  let m;
  while ((m = QUERY_PARAM.exec(text)) !== null) {
    const norm = normalizeName(m[1]);
    if ((isSecretName(norm) || norm === 'key' || norm === 'sig' || norm === 'signature') && holdsCredential(m[2], false)) names.push(norm);
  }
  return names;
}

// The environment variable name suggested for a value: the name that holds it,
// with a prefix when that name only says "a token" and not what it is for.
function suggestedName(norm) {
  let up = (norm || 'secret').toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 56).replace(/_+$/, '');
  const generic = norm.split('_').every((w) => !w || GENERIC_WORDS.has(w));
  if (generic || !/^[A-Z]/.test(up)) up = 'MCP_' + up;
  return up;
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

/**
 * Credentials in the text of an MCP configuration file: one result per
 * value, { line, kind, name }. `kind` is "environment variable", "header",
 * "setting", "argument" or "URL". `name` is the name that holds the value (a
 * key, a flag or a URL parameter), restricted to plain characters.
 */
function findMcpConfigSecrets(text) {
  const found = [];
  const seen = new Set();
  const add = (line, kind, name) => {
    const key = line + '\0' + kind + '\0' + name;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ line, kind, name: safeName(name) });
  };
  const lines = String(text).split('\n');
  let pending = null; // a credential flag whose value is the next string
  for (let ln = 1; ln <= lines.length; ln++) {
    const line = lines[ln - 1].replace(/\r$/, '');
    if (!line.trim()) continue;
    const toks = tokenize(line);
    const hadPending = pending !== null;
    let usedPending = false;
    for (let t = 0; t < toks.length; t++) {
      const tok = toks[t];
      const next = toks[t + 1];
      if (tok.sep) {
        // A key. Its value is the string that follows it.
        if (next && next.str && next.start === tok.valueAt) {
          pair(ln, tok.text, next.text, add);
          t++;
        }
        continue;
      }
      // A string with no separator: an array item (an argument).
      if (!tok.str) continue;
      const s = tok.text;
      if (pending !== null) {
        const flag = pending;
        pending = null;
        usedPending = true;
        if (!s.startsWith('-') && holdsCredential(s, true)) { add(ln, 'argument', flag); continue; }
      }
      argument(ln, s, add, (f) => { pending = f; });
    }
    // A flag waits for its value only across comment and blank lines.
    if (hadPending && !usedPending && pending !== null && !/^\s*(?:#|\/\/|\/\*|\*)/.test(line)) pending = null;
  }
  return found;
}

function pair(ln, name, value, add) {
  const norm = normalizeName(name);
  if (isSecretName(norm)) {
    if (holdsCredential(value, true)) {
      const kind = HEADER_NAMES.has(norm) ? 'header' : (/^[A-Z0-9_]+$/.test(name) ? 'environment variable' : 'setting');
      add(ln, kind, name);
      return;
    }
  } else if (SCHEME_VALUE.test(value) && holdsCredential(value, true)) {
    add(ln, 'header', name);
    return;
  }
  for (const p of urlParamNames(value)) add(ln, 'URL', p);
}

function argument(ln, s, add, setPending) {
  const eq = FLAG_EQ.exec(s.length > 4096 ? s.slice(0, 4096) : s);
  if (eq && s.length <= 4096) {
    if (isSecretName(normalizeName(eq[1])) && holdsCredential(eq[2], false)) add(ln, 'argument', eq[1].replace(/^-+/, ''));
    return;
  }
  if (FLAG.test(s)) {
    if (isSecretName(normalizeName(s))) setPending(s.replace(/^-+/, ''));
    return;
  }
  const h = s.length <= 4096 ? HEADER_ARG.exec(s) : null;
  if (h) {
    if (holdsCredential(h[2], true)) add(ln, 'header', h[1]);
    return;
  }
  for (const p of urlParamNames(s)) add(ln, 'URL', p);
}

function mcpSample(kind, name) {
  if (kind === 'argument') return `${name} [REDACTED]`;
  if (kind === 'URL') return `URL parameter ${name}=[REDACTED]`;
  return `${name} = [REDACTED]`;
}

function mcpReason(kind) {
  return `Plaintext credential in an MCP server configuration (${kind})`;
}

function mcpNextStep(kind, name) {
  const norm = normalizeName(name);
  const use = suggestedName(norm);
  if (kind === 'header' || kind === 'URL') {
    return `Next: take the value out of this file and refer to an environment variable instead, written the way your agent expects (for example \${${use}} in Claude Code, \${env:${use}} in Cursor and VS Code, {env:${use}} in OpenCode), keep the real value in your own shell settings or a secret manager, and rotate it if the file was ever committed or shared.`;
  }
  return `Next: run npx -y zn-gate secret set ${use} to store the value in the local vault (it asks for the value, so it is never typed on a command line), run zn secret allow ${use} --command <the server's command> so zn run may use it, put __ZN_${use}__ in this file instead, start the server through zn run (see docs/secrets.md), and rotate the value if the file was ever committed or shared.`;
}

module.exports = { RULE_ID, isMcpConfigPath, findMcpConfigSecrets, mcpNextStep, mcpSample, mcpReason, normalizeName, isSecretName, suggestedName };
