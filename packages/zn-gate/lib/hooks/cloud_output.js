'use strict';

/*
 * The one hook-side file that can reach the zn cloud: it asks the cloud check about a sample of tool output (see
 * cloudOutputNote in runner.js, which decides whether to ask and what to send). Kept apart so the rule "no other hook,
 * shield or scrubber module reads the stored key or the cloud settings" stays easy to test (test/connect.test.js).
 *
 * Personal data (email, phone, IBAN, card number) is replaced with [EMAIL], [PHONE], [IBAN], [CARD] after the secrets.
 * It sends nothing unless the person turned the optional cloud check on (ZN_CLOUD=1 with a key, or zn-gate connect,
 * and not ZN_LOCAL_ONLY). analyze() applies the prompt check's own steps: the local rules first, the secret
 * redaction before the request, the same timeouts and the same fallback to the local rules when the call fails.
 * pinOrigin keeps the key and the text on the fixed zn origin: an environment variable of the agent (a project can set
 * it) cannot point them elsewhere, and a TLS setting that weakens the check stops the request.
 */

// Personal data kinds removed from the sample before it leaves the machine (the scrubber's own detectors, so the
// checks that already decide what counts as an email, a phone number, an IBAN or a card number are the ones used here).
const PII_ONLY = { email: true, phone: true, iban: true, card: true, dni: false, ssn: false, ipv4: false, name: false, address: false, username: false };
const PII_PLACEHOLDER = { EMAIL: '[EMAIL]', PHONE: '[PHONE]', IBAN: '[IBAN]', CARD: '[CARD]' };

/* The text with secrets and then personal data replaced. Throws when it cannot: the caller then sends nothing. */
function redactForCloud(sample) {
  const secrets = require('../rules').redactSecrets(sample);
  if (!secrets || typeof secrets.sanitized !== 'string') throw new Error('redaction failed');
  let text = secrets.sanitized;
  const spans = require('../scrub/patterns').findPii(text, { pii: PII_ONLY })
    .filter((s) => PII_PLACEHOLDER[s.type])
    .sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let last = 0;
  for (const s of spans) {
    if (s.start < last) continue;
    out += text.slice(last, s.start) + PII_PLACEHOLDER[s.type];
    last = s.end;
  }
  return out + text.slice(last);
}

/** The analyze() result for the sample, or null when the cloud check is off or nothing could be asked. */
async function ask(sample, timeoutMs) {
  // Cheap test before the client is loaded: nothing of it runs when the cloud check is off.
  if (process.env.ZN_CLOUD !== '1' && !require('../cloud-key').isConnected()) return null;
  const client = require('../client');
  if (!client.isCloudEnabled()) return null;
  // Secrets, then personal data, are replaced before the request is built; if that fails nothing is sent.
  const clean = redactForCloud(sample);
  return client.analyze(clean, { pinOrigin: true, timeout: timeoutMs });
}

module.exports = { ask, redactForCloud };
