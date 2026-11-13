'use strict';
/* Messages write zn commands for the machine they run on (`zn.cmd` on Windows, `npx -y zn-gate@<version>` when zn is
 * not on PATH; see lib/zn-command.js). asTyped writes them back as `zn ...`, so a test can pin the sentence once. */

const { znCommand } = require('../../lib/zn-command');

const PREFIX = znCommand('') + ' ';

function asTyped(text) {
  return PREFIX === 'zn ' ? text : String(text).split(PREFIX).join('zn ');
}

module.exports = { asTyped };
