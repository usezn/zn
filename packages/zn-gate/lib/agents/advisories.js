'use strict';

/**
 * Published security advisories for the coding agents found on this machine. Read only and offline: the table is
 * data/agent-advisories.json in the package. An agent version that cannot be read as x.y.z never matches (no false alarm).
 */

const TABLE = require('../data/agent-advisories.json').entries;
const { compareVersions } = require('./versions');

function inRange(version, range) {
  if (!range || typeof range !== 'object') return false;
  if (range.below !== undefined) {
    const c = compareVersions(version, range.below);
    return c !== null && c < 0;
  }
  if (range.atOrBelow !== undefined) {
    const c = compareVersions(version, range.atOrBelow);
    return c !== null && c <= 0;
  }
  return false;
}

/** The advisories (from `table`, default the shipped one) whose affected range holds `version` of agent `id`. */
function advisoriesFor(id, version, table = TABLE) {
  if (!id || !version || !/^\d+\.\d+\.\d+/.test(String(version))) return [];
  return table
    .filter((e) => e.agent === id && inRange(version, e.affected))
    .map((e) => ({ id: e.id, cve: e.cve || null, installed: String(version), fixed: e.fixed || null, url: e.url, published: e.published, source: e.source }));
}

/** One plain sentence for an advisory from advisoriesFor. */
function advisoryLine(a, name) {
  const cve = a.cve ? `${a.cve}, ` : '';
  const fix = a.fixed ? `Version ${a.fixed} fixes it` : 'The advisory lists no fixed version';
  return `${name} ${a.installed} is in the affected range of a published security advisory (${cve}${a.id}). ${fix}. Details: ${a.url}`;
}

module.exports = { advisoriesFor, advisoryLine, TABLE };
