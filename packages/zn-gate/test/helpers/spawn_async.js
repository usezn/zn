'use strict';
/* Child processes started without blocking the test, so that several of them run at the same time. spawnAsync resolves with
   the fields spawnSync gives: status (null when the process was killed or never started), stdout, stderr and error, which is
   ETIMEDOUT when the timeout ended the process. runPool runs an async function over a list, a few items at a time. */

const { spawn } = require('child_process');

function spawnAsync(file, args, { cwd, env, input, timeout } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let error = null;
    let timer = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // A process that answers and exits before it reads its input makes this write fail (EPIPE, or EOF on Windows). spawnSync
    // reports that as an error too; the caller decides what it means.
    child.stdin.on('error', (err) => { if (!error) error = err; });
    child.on('error', (err) => {
      error = err;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error });
    });
    if (timeout) {
      timer = setTimeout(() => {
        error = Object.assign(new Error('spawn ' + file + ' ETIMEDOUT'), { code: 'ETIMEDOUT' });
        child.kill();
      }, timeout);
    }
    child.stdin.end(input === undefined ? '' : input);
  });
}

async function runPool(items, fn, width = 4) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

module.exports = { spawnAsync, runPool };
