### Fixed
- The gateway now reports an error when an upstream MCP server closes its output before a reply or in the middle of one, instead of passing on an empty or cut-off reply.

### Changed
- More tests for the gateway REST handlers, the AWS KMS vault and the MCP proxy (access by namespace and role, failed key generation and signing, damaged key files, the environment allowlist, config files and process shutdown).
