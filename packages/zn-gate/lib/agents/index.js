'use strict';

/**
 * Agent adapter registry. Each adapter implements
 *   {id, detect(), install({scope}), uninstall(), normalize(raw), respond(decision)}
 */

const ADAPTERS = {
  'claude-code': () => require('./claude-code'),
  codex: () => require('./codex'),
  cursor: () => require('./cursor'),
  opencode: () => require('./opencode'),
  antigravity: () => require('./antigravity'),
  gemini: () => require('./gemini'),
};

const ALIASES = { claude: 'claude-code', claudecode: 'claude-code', 'gemini-cli': 'gemini', geminicli: 'gemini' };

function getAdapter(id) {
  const key = ALIASES[String(id || '').toLowerCase()] || String(id || '').toLowerCase();
  const load = ADAPTERS[key];
  if (!load) {
    throw new Error('unknown agent "' + id + '" (supported: ' + Object.keys(ADAPTERS).join(', ') + ')');
  }
  return load();
}

// Agents zn has no hooks for yet (display name by the name people type).
const NOT_COVERED = {
  gemini: 'Gemini CLI',
  'gemini-cli': 'Gemini CLI',
  copilot: 'GitHub Copilot CLI',
  'copilot-cli': 'GitHub Copilot CLI',
  'github-copilot': 'GitHub Copilot CLI',
};

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** One plain sentence when `id` is not an agent zn can install hooks for, or null when it is. */
function unsupportedAgentMessage(id) {
  const key = String(id || '').toLowerCase();
  if (ALIASES[key] || ADAPTERS[key]) return null;
  const supported = 'Supported agents: ' + Object.keys(ADAPTERS).join(', ') + '.';
  if (NOT_COVERED[key]) return 'zn hooks are not available for ' + NOT_COVERED[key] + ' yet. ' + supported;
  let best = null;
  let bestD = 3;
  for (const name of [...Object.keys(ADAPTERS), ...Object.keys(ALIASES)]) {
    const d = distance(key, name);
    if (d < bestD) { best = name; bestD = d; }
  }
  return 'unknown agent "' + id + '".' + (best ? ' Did you mean "' + best + '"?' : '') + ' ' + supported;
}

function listAdapters() {
  return Object.keys(ADAPTERS);
}

module.exports = { getAdapter, listAdapters, unsupportedAgentMessage };
