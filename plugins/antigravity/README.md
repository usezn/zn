# zn-gate plugin for the Antigravity CLI

zn-gate as an Antigravity CLI plugin: it checks every tool call for secrets before Antigravity runs it.

- Blocks reads and writes of secret files (`.env` with values, `~/.aws/credentials`, `~/.zn`) and shell commands that read
  them or handle the vault. The same checks as `zn hooks install antigravity`: one `PreToolUse` hook on every tool.
- No account and no API key. Nothing is sent over the network.
- Ships its own copy of zn-gate (`vendor/zn-gate`). `scripts/zn-launch.js` checks it against
  `scripts/zn-gate.lock.json` (SHA-256 of every file of the published release) on every call and fails closed.
  Antigravity does not install npm packages for a plugin, so there is no `node_modules` to go missing.
- Needs Node.js 20.19 or later on the machine: `scripts/zn-hook.sh` looks for `node` in the PATH of the hook and in the
  usual install folders. When it finds none, or zn cannot answer within 12 seconds, the hook answers `deny` with the
  reason instead of leaving the decision to Antigravity.

## Install

Install steps are published with the plugin repository. Until then, use `zn hooks install antigravity`.

## Do not install the hooks twice

With both this plugin and `zn hooks install antigravity`, every call is checked twice. The answers are the same, so
nothing breaks, but it costs time. Use one of them.

## Limits

- Antigravity documents plugin hooks for the CLI only. This plugin is not tested in the Antigravity app or the IDE.
- What was measured: the Antigravity CLI 1.4.7 on Linux (Ubuntu 24.04). macOS and Windows are not tested. The hook is a
  POSIX shell script started with `sh`, so Windows is not supported by the plugin yet: use
  `zn hooks install antigravity` there.
- Antigravity does not document how a plugin hook is started or what it does when the hook fails. On 1.4.7 it runs
  the command from the folder the plugin is installed in, and denied every call whose hook failed or timed out. The hook does not
  rely on that: it prints its own `deny` decision.
- Antigravity hooks cannot rewrite or redact what a tool returns, so a value printed by a command or a file the agent is
  allowed to read reaches the model. Keep secrets in the vault.
- A user can turn the plugin off (`agy plugin disable zn-gate`). Code that runs as your user can edit the plugin folder,
  like any other plugin.
