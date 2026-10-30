### Changed
- On Windows, the hook launcher now starts one Node.js process instead of about two dozen helper programs, so each tool call is checked faster. It keeps the same safety rules: a missing or changed zn-gate, a crash, an unconfirmed answer or a hook that runs too long still blocks the call. Run `zn hooks install` again, or update zn-gate, to switch an existing launcher.
