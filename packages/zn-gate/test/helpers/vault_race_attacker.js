'use strict';
const fs = require('fs');
const [file, s0] = process.argv.slice(2);
const size0 = Number(s0);
const buf = fs.readFileSync(file).toString('utf8');
const lines = buf.split('\n').filter(Boolean);
const i = Math.floor(lines.length / 2);
let off = 0; for (let k = 0; k < i; k++) off += Buffer.byteLength(lines[k]) + 1;
const p = lines[i].indexOf('"ts":"') + 6 + 3;
const ch = lines[i][p] === '1' ? '2' : '1';
const fd = fs.openSync(file, 'r+');
process.stdout.write('ready\n');
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  if (fs.fstatSync(fd).size > size0) { fs.writeSync(fd, ch, off + p); break; }
}
fs.closeSync(fd);
