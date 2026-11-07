### Fixed
- `zn audit` no longer prints the path, query string, user or password of any URL in a finding's detail or evidence, including a proxy written without a scheme as `user:password@host` (also with an empty user, an IPv6 host, or `/`, `\` or `@` in the password); only `scheme://host[:port]` is shown, and ZNA002 shows its download URL without user or password.
