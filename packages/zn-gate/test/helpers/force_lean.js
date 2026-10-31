'use strict';

// Preload (node --require) that makes every launcher written or compared in a test the lean (Windows) one, on any system:
//   node --require ./test/helpers/force_lean.js --test test/hooks_launcher_integrity.test.js ...
// The lean script runs under plain sh as well, so the launcher tests prove the same guarantees for it. Only for tests.
const launcher = require('../../lib/agents/launcher');
const { writeLauncher, unixScript } = launcher;
launcher.writeLauncher = (a, n, r, o = {}) => writeLauncher(a, n, r, { ...o, lean: true });
launcher.unixScript = (a, n, r, o = {}) => unixScript(a, n, r, { ...o, lean: true });
