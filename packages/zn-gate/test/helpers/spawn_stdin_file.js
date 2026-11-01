'use strict';
/*
 * spawnSync with the input given to the child as a regular file on stdin, not a pipe.
 *
 * Node's pipes are Unix socket pairs. A bash built with the Debian/Ubuntu SSH patch reads ~/.bashrc when its stdin is a
 * socket (it takes the shell to be run by sshd). A ~/.bashrc that sets PATH then replaces the PATH a test gave the shell,
 * and the test measures the machine and not the guard. With a file on stdin that startup file is never read.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function spawnStdinFile(command, args, options = {}) {
  const { input = '', ...rest } = options;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-stdin-'));
  const file = path.join(dir, 'in');
  fs.writeFileSync(file, input);
  const fd = fs.openSync(file, 'r');
  try {
    return spawnSync(command, args, { ...rest, stdio: [fd, 'pipe', 'pipe'] });
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { spawnStdinFile };
