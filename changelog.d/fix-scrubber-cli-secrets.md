### Security
- The secret scrubber and `redactSecrets` / `redact_secrets` now hide the value of a credential given on a command
  line, in the Node.js and the Python package alike: `--password`, `--passwd`, `--pass`, `--api-key`, `--token`,
  `--secret` and `--client-secret` (as `--flag=value` or `--flag value`), the password of `curl -u user:password`,
  `mysql -pPASSWORD` after a `mysql` or `mariadb` command, and `PGPASSWORD=value`. References (`$DB_PASS`) and
  placeholders (`<password>`, `changeme`) are left alone. Before, Node.js left `--password=value` visible and Python
  hid it only in the preview of `zn-gate test`. `zn-gate scan` reports these values under the same rule,
  `secret:cli_credential_flag`, which now also covers values shorter than 8 characters.
