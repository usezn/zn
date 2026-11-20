### Security
- `zn --api-key-file <path>` reads the gateway API key from a file, and `ZN_API_KEY` still works, so the key no longer has to appear in the process list. The `--api-key` flag keeps working but is deprecated and prints a warning, because other users on the machine can read it with `ps` or `/proc`.
- The debug output of the audit, SIEM and webhook settings no longer prints the database encryption key, the SIEM token or the secret part of a webhook URL.
