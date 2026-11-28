'use strict';
// Like export_redaction.js, but one text that makes redactSecrets throw does not stop the batch:
// the answer for it is {"error": "<message>"} and every other answer is {"out": "<sanitized>"}.
const fs = require('fs');
const path = require('path');
const { redactSecrets } = require(path.join(__dirname, '..', '..', 'lib', 'rules'));

const texts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.stdout.write(JSON.stringify(texts.map((t) => {
  try {
    return { out: redactSecrets(t).sanitized };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
})));
