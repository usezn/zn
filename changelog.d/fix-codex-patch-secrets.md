### Security
- Codex and OpenCode `apply_patch` patches that add, update or delete a plain-text `.env` file, a credentials file such as `~/.aws/credentials`, or a private key are now blocked, as the install page says. A `.env` file that holds only zn markers can still be patched.
