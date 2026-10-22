// Fails when a manifest under examples/ has no matching entry in .github/dependabot.yml, so a new
// example cannot be forgotten. Run: node .github/scripts/check-dependabot-examples.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFESTS = [
  { file: 'requirements.txt', ecosystem: 'pip' },
  { file: 'package.json', ecosystem: 'npm' },
  { file: 'Dockerfile', ecosystem: 'docker' },
];

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

// Minimal reader for the layout of dependabot.yml: returns [{ ecosystem, directories }].
export function parseEntries(text) {
  const entries = [];
  let cur = null;
  let inList = false;
  const add = (v) => cur.directories.push(unquote(v));
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    let m = line.match(/^\s*-\s+package-ecosystem:\s*(\S+)/);
    if (m) {
      cur = { ecosystem: unquote(m[1]), directories: [] };
      entries.push(cur);
      inList = false;
      continue;
    }
    if (!cur) continue;
    m = line.match(/^\s+directory:\s*(\S.*)$/);
    if (m) { add(m[1]); inList = false; continue; }
    if (/^\s+directories:\s*$/.test(line)) { inList = true; continue; }
    m = line.match(/^\s+directories:\s*\[(.*)\]\s*$/);
    if (m) { m[1].split(',').filter((s) => s.trim()).forEach(add); inList = false; continue; }
    m = line.match(/^\s+-\s+(\S.*)$/);
    if (inList && m) { add(m[1]); continue; }
    if (/^\s+\S/.test(line)) inList = false;
  }
  return entries;
}

// Returns the list of problems; empty when every example manifest is covered.
export function check(entries, manifests) {
  const covered = new Set();
  for (const e of entries) {
    for (const d of e.directories) covered.add(`${e.ecosystem} ${d.replace(/\/+$/, '')}`);
  }
  const problems = [];
  for (const { ecosystem, dir, file } of manifests) {
    if (!covered.has(`${ecosystem} ${dir}`)) {
      problems.push(`${file}: no ${ecosystem} entry for directory "${dir}" in .github/dependabot.yml`);
    }
  }
  return problems;
}

export function findManifests(root) {
  const found = [];
  const base = join(root, 'examples');
  if (!existsSync(base)) return found;
  for (const dir of readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const { file, ecosystem } of MANIFESTS) {
      if (existsSync(join(base, dir.name, file))) {
        found.push({ ecosystem, dir: `/examples/${dir.name}`, file: `examples/${dir.name}/${file}` });
      }
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entries = parseEntries(readFileSync('.github/dependabot.yml', 'utf8'));
  const manifests = findManifests('.');
  if (manifests.length === 0) {
    console.error('No example manifests found: run this from the repository root.');
    process.exit(1);
  }
  const problems = check(entries, manifests);
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error('Add the directory to the matching entry in .github/dependabot.yml (security updates only).');
    process.exit(1);
  }
  console.log(`OK: ${manifests.length} example manifests covered by .github/dependabot.yml`);
}
