'use strict';
// Test launcher: runs startMcpShield() in its own process, because the shield
// takes over stdin/stdout and calls process.exit.
//   node shield_launcher.js <command> [args...]
// Shield options come from the ZN_TEST_SHIELD_OPTS environment variable (JSON).

const path = require('path');
const { startMcpShield } = require(path.join(__dirname, '..', '..', 'lib', 'shield'));

const opts = process.env.ZN_TEST_SHIELD_OPTS ? JSON.parse(process.env.ZN_TEST_SHIELD_OPTS) : {};
const [command, ...args] = process.argv.slice(2);
startMcpShield(command, args, opts);
