### Fixed
- The scrubber and the redaction rules now read four provider formats that stayed readable, the same way in the
  Node.js and Python packages: the JFrog Artifactory reference token (`cmVmd`, 64 characters), the Dynatrace
  tokens with a `dt0s0x` style prefix (`dt0s01`, `dt0s02`, `dt0s16` and the like), a 1Password service account
  token whose body uses `-` and `_` (base64url), and a SendGrid API key longer than the usual 69 characters.
  The older forms keep their own rules, and the retired Teams connector webhook URL is still redacted.
