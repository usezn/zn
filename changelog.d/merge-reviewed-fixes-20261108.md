### Fixed
- An approval recorded by `zn audit --approve` in an older format is no longer ignored: the audit now reports it as ZNA023 (high) and asks you to run `zn audit --approve` again, instead of showing no finding.
- A `.env` value such as `API_KEY=https://example.com` now counts as a plain secret: only a variable whose name ends in `_URL` or `_URI` is skipped when its URL carries no password. `POLICY_RULES_VERSION` is `2026-11-10.1`.
- The text `zn env shadow` prints about a value it left in clear text now says that the zn read hook blocks agents from reading the file, and that without the hook it should be treated as readable.
