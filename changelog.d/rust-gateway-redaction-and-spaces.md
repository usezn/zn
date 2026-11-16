### Fixed
- Rust gateway: an override phrase whose words are separated by a no-break space or another Unicode space (such as U+2009 or U+3000) is now blocked, the same as in the Node.js hook.
- `scripts/verify-release.sh` now also checks that the package on npm is the release file: the SHA-512 of `zn-gate-<version>.tgz` must equal the integrity npm shows for that version, or step 4 fails.
### Security
- Rust gateway: the live event stream (`/api/v1/events`) and the SIEM export now carry the same redacted agent id and policy name as the audit database. A token placed in an agent id no longer leaves through them.
- Rust gateway: the startup log line for the SIEM exporter now shows only the scheme, host and port of the endpoint, never a user name, password, path or query.
