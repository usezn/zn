'use strict';
/* Expected command text for tests: on Windows the product prints the .cmd
 * forms (`zn.cmd`, `npx.cmd`), elsewhere the plain names. */
const { cliName, winCommandText, winManualText } = require('../../lib/zn-command');

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const ZN = cliName('zn');
const NPXN = cliName('npx');
const GATE = cliName('zn-gate');

// `(zn|npx -y zn-gate@<version>)` in a pattern: the names the platform prints.
function winRe(re) {
  if (process.platform !== 'win32') return re;
  const src = re.source.replace(/\((\?:)?zn\|npx -y zn-gate@/g, (m, nc) => '(' + (nc || '') + escRe(ZN) + '|' + escRe(NPXN) + ' -y zn-gate@');
  return new RegExp(src, re.flags);
}

// Every `zn <command>` and `npx -y zn-gate <command>` in a pattern, written with the names the platform prints.
function winCmdRe(re) {
  if (process.platform !== 'win32') return re;
  const src = winManualText(winRe(re).source, 'win32').replace(/\b(zn-gate|zn|npx)\.cmd/g, '$1\\.cmd');
  return new RegExp(src, re.flags);
}

module.exports = {
  ZN,
  NPXN,
  GATE,
  // The same names, escaped to sit inside a regular expression source.
  ZN_RE: escRe(ZN),
  NPX_RE: escRe(NPXN),
  GATE_RE: escRe(GATE),
  escRe,
  winRe,
  winCmdRe,
  // A message written with plain names, as the platform prints it (commands between backticks).
  win: (text) => winCommandText(text),
  // A command line written with plain names, as the platform prints it.
  winCmd: (text) => winManualText(text),
};
