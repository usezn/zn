'use strict';
// Error text of the "backup is not in the same directory" checks in safeRestore
// and in configureEnvironments (revert, dry run). Temporary folders only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { configureEnvironments, safeRestore } = require('../lib/init');

const CFG = '{"mcpServers":{"fetch":{"command":"uvx","args":["mcp-server-fetch"]}}}\n';
const SAMEDIR_MSG = 'backup is not in the same directory as the config';
// realpath: on macOS os.tmpdir() is under /var, a link to /private/var.
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zn-init-errors-')));
const canLink = (() => {
  const d = tmp();
  try { fs.symlinkSync(d, path.join(d, 'l'), 'dir'); return true; } catch { return false; } finally { fs.rmSync(d, { recursive: true, force: true }); }
})();
const linkOpts = { skip: !canLink && 'symlinks unavailable' };

test('safeRestore throws an Error when the backup sits in the parent folder', () => {
  const d = tmp();
  try {
    const sub = path.join(d, 'sub');
    fs.mkdirSync(sub);
    const f = path.join(sub, 'mcp.json');
    fs.writeFileSync(f, CFG);
    const b = path.join(d, 'mcp.json.bak.1');
    fs.writeFileSync(b, '{"mcpServers":{}}');
    assert.throws(() => safeRestore(b, f), (e) => {
      assert.ok(e instanceof Error);
      assert.equal(e.message, SAMEDIR_MSG);
      return true;
    });
    assert.equal(fs.readFileSync(f, 'utf8'), CFG, 'the config is unchanged');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('configureEnvironments dry-run revert reports the error when the config folder link changes during the scan', linkOpts, () => {
  const d = tmp();
  const origReaddir = fs.readdirSync;
  try {
    const a = path.join(d, 'a');
    const b = path.join(d, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, 'mcp.json'), CFG);
    fs.writeFileSync(path.join(b, 'mcp.json'), CFG);
    const bak = path.join(a, 'mcp.json.bak.1700000000000');
    fs.writeFileSync(bak, '{"mcpServers":{}}');
    const link = path.join(d, 'cfg');
    fs.symlinkSync(a, link, 'dir');
    const f = path.join(link, 'mcp.json');

    // Point the folder link elsewhere right after the backup folder is listed,
    // as if it were swapped between the checks.
    fs.readdirSync = function (dir, ...rest) {
      const names = origReaddir.call(this, dir, ...rest);
      if (dir === a) {
        fs.readdirSync = origReaddir;
        fs.unlinkSync(link);
        fs.symlinkSync(b, link, 'dir');
      }
      return names;
    };

    const r = configureEnvironments({
      envList: [{ name: 'T', id: 'claude-desktop', filePath: f, key: 'mcpServers' }],
      revert: true,
      dryRun: true,
    });
    assert.equal(r.actions.length, 1);
    assert.equal(r.actions[0].status, 'skipped_unsafe');
    assert.equal(r.actions[0].error, `${bak}: ${SAMEDIR_MSG}; skipped`);
    assert.equal(fs.readFileSync(path.join(a, 'mcp.json'), 'utf8'), CFG);
    assert.equal(fs.readFileSync(path.join(b, 'mcp.json'), 'utf8'), CFG);
  } finally {
    fs.readdirSync = origReaddir;
    fs.rmSync(d, { recursive: true, force: true });
  }
});
