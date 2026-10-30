// Lists the licenses of the production dependencies installed under a
// node_modules directory and compares them with an allowlist of SPDX ids.
// Informational: it always exits 0 and writes the findings as a markdown
// table (to $GITHUB_STEP_SUMMARY when set) and as workflow warnings.
// Usage: node license-check.mjs <node_modules dir> <allowlist file>
import { readdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [root, allowFile] = process.argv.slice(2);
if (!root || !allowFile) {
  console.error('usage: license-check.mjs <node_modules dir> <allowlist file>');
  process.exit(2);
}
const allowed = new Set(
  readFileSync(allowFile, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')),
);

function packageDirs(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    const path = join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      found.push(...packageDirs(path));
      continue;
    }
    if (existsSync(join(path, 'package.json'))) found.push(path);
    const nested = join(path, 'node_modules');
    if (existsSync(nested)) found.push(...packageDirs(nested));
  }
  return found;
}

function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (!l) return 'UNKNOWN';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => x.type ?? String(x)).join(' OR ');
  return l.type ?? 'UNKNOWN';
}

class ParseError extends Error {}

// SPDX expression: "AND" binds tighter than "OR", parentheses group.
// An OR is allowed when any alternative is; an AND only when every part is.
// Unknown ids and anything that does not parse are not allowed.
function isAllowed(expr) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const atom = () => {
    const tok = tokens[pos];
    if (tok === undefined || tok === ')' || tok === 'AND' || tok === 'OR') throw new ParseError(expr);
    pos += 1;
    if (tok === '(') {
      const value = orExpr();
      if (tokens[pos] !== ')') throw new ParseError(expr);
      pos += 1;
      return value;
    }
    return allowed.has(tok);
  };
  const andExpr = () => {
    let value = atom();
    while (tokens[pos] === 'AND') {
      pos += 1;
      const next = atom();
      value = value && next;
    }
    return value;
  };
  const orExpr = () => {
    let value = andExpr();
    while (tokens[pos] === 'OR') {
      pos += 1;
      const next = andExpr();
      value = value || next;
    }
    return value;
  };
  try {
    const value = orExpr();
    return pos === tokens.length && value;
  } catch (err) {
    if (err instanceof ParseError) return false;
    throw err;
  }
}

const rows = packageDirs(root)
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return { name: pkg.name ?? dir, version: pkg.version ?? '?', license: licenseOf(pkg) };
  })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const findings = rows.filter((r) => !isAllowed(r.license));
const lines = [
  `### npm production dependencies: ${rows.length} package(s), ${findings.length} outside the allowlist`,
  '',
  '| Package | Version | License | Status |',
  '|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${isAllowed(r.license) ? 'ok' : 'review'} |`),
  '',
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
for (const f of findings) {
  console.log(`::warning title=License outside the allowlist::${f.name}@${f.version} is ${f.license}`);
}
