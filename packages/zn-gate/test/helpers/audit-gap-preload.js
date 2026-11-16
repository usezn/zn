// Test preload: makes the agent-config audit report partial coverage.
const audit = require('../../lib/audit');
const real = audit.audit;
audit.audit = (o) => {
  const r = real(o);
  if (process.env.ZN_TEST_AUDIT_GAP === 'truncated') r.truncated = true;
  if (process.env.ZN_TEST_AUDIT_GAP === 'dirs') r.skippedDirs = [{ dir: 'x', reason: 'cannot be read' }];
  return r;
};
