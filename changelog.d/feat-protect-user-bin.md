### Security
- The agent hooks now refuse an agent's writes to the programs the hooks start by name (`node`, `sh`, `bash`, `zn`,
  `zn-gate`) in the folders of your own programs that are usually on the `PATH` (`~/.local/bin`, `~/bin`, the nvm,
  fnm and Volta folders, `/usr/local/bin`, `/opt/homebrew/bin` and others listed in `docs/compat.md`). A `node`
  written there would run in place of the real one at the next call, without zn's checks. Other programs in these
  folders stay writable. `POLICY_RULES_VERSION` is `2026-10-26.8`.
