'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { verifyEvidenceLedger } = require('../lib/evidence');

const EVIDENCE_JS = path.join(__dirname, '..', 'lib', 'evidence.js');
const PER = 100;

const WRITER = `
const { logEvidence } = require(process.argv[1]);
const [file, id, n] = [process.argv[2], process.argv[3], Number(process.argv[4])];
for (let i = 0; i < n; i++) {
  const rec = logEvidence({ agent: 'test-agent', phase: 'tool-call', tool_name: 'bash', payload: 'w' + id + '-' + i, verdict: 'allow' }, file);
  if (!rec) process.exit(3);
}
`;

function run(id, file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', WRITER, EVIDENCE_JS, file, id, String(PER)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, err }));
  });
}

test('two processes appending 100 entries each lose nothing and the chain verifies', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zn-ev-two-'));
  const file = path.join(dir, 'evidence.jsonl');
  try {
    const results = await Promise.all([run('a', file), run('b', file)]);
    for (const r of results) assert.equal(r.code, 0, r.err);

    const v = verifyEvidenceLedger(file);
    assert.equal(v.error, null);
    assert.equal(v.valid, true);
    assert.equal(v.total, 2 * PER);
    assert.equal(v.verified, 2 * PER);

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 2 * PER);
    const hashes = new Set(lines.map((l) => JSON.parse(l).record_hash));
    assert.equal(hashes.size, 2 * PER, 'every record hash is distinct');

    // Each writer's entries are all present and stay in the order that writer wrote them.
    const text = lines.join('\n');
    for (const id of ['a', 'b']) {
      let last = -1;
      for (let i = 0; i < PER; i++) {
        const at = text.indexOf(`"w${id}-${i}"`);
        assert.ok(at > last, `entry w${id}-${i} is present and in order`);
        last = at;
      }
    }
    assert.equal(fs.existsSync(file + '.lock'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
