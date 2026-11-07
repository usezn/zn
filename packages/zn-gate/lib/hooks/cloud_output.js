'use strict';

/*
 * The one hook-side file that can reach the zn cloud: it asks the cloud check about a sample of tool output (see
 * cloudOutputNote in runner.js, which decides whether to ask and what to send). Kept apart so the rule "no other hook,
 * shield or scrubber module reads the stored key or the cloud settings" stays easy to test (test/connect.test.js).
 *
 * It sends nothing unless the person turned the optional cloud check on (ZN_CLOUD=1 with a key, or zn-gate connect,
 * and not ZN_LOCAL_ONLY). analyze() applies the prompt check's own steps: the local rules first, the secret
 * redaction before the request, the same timeouts and the same fallback to the local rules when the call fails.
 * pinOrigin keeps the key and the text on the fixed zn origin: an environment variable of the agent (a project can set
 * it) cannot point them elsewhere, and a TLS setting that weakens the check stops the request.
 */

/** The analyze() result for `sample`, or null when the cloud check is off or nothing could be asked. */
async function ask(sample, timeoutMs) {
  // Cheap test before the client is loaded: nothing of it runs when the cloud check is off.
  if (process.env.ZN_CLOUD !== '1' && !require('../cloud-key').isConnected()) return null;
  const client = require('../client');
  if (!client.isCloudEnabled()) return null;
  return client.analyze(sample, { pinOrigin: true, timeout: timeoutMs });
}

module.exports = { ask };
