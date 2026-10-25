# zn-gate plugin for the ZCode desktop app

zn-gate 1.13.1 as a ZCode plugin: it checks every tool call and prompt for secrets before ZCode runs it.

- Blocks reads and writes of secret files (`.env` with values, `~/.aws/credentials`, `~/.zn`), shell commands that read them
  or handle the vault, MCP calls that would send a secret to a server, and prompts that contain a secret.
- Keeps working when ZCode's own hooks switch (`hooks.enabled`) is off: ZCode runs the hooks of a plugin whatever
  that switch says. This is the main reason to use the plugin instead of `zn hooks install zcode`.
- No account and no API key. Nothing is sent over the network.
- Ships its own copy of zn-gate (`vendor/zn-gate`). `scripts/zn-launch.js` checks it against
  `scripts/zn-gate.lock.json` (SHA-256 of every file of the published release) on every call and fails closed.
  ZCode does not install npm packages, so there is no `node_modules` to go missing.
- Needs Node.js 20.19 or later on the machine, or ZCode's own: `scripts/zn-hook.sh` looks for `node` in the PATH of the
  hook and in the usual install folders, and falls back to the program that runs ZCode's agent. When it finds none, it
  blocks instead of letting the call run (ZCode lets a call run when a hook cannot start; only exit code 2 blocks).

## Install

In ZCode, open Settings, then Plugins, add the marketplace for this plugin and install **zn-gate**. Start a new session:
a running session keeps the hooks it started with.

## Do not install the hooks twice

ZCode does not remove duplicates: with both this plugin and `zn hooks install zcode`, every call is checked twice.
Use one of them. `zn-gate check` reports it when both are active, and when the plugin is turned off while
`hooks.enabled` is false (then nothing protects ZCode).

## Limits

- Linux (tested with the ZCode desktop app 3.16.3). macOS is not tested. The hook is a POSIX shell script, so
  Windows is not supported by the plugin yet: use `zn hooks install zcode` there.
- ZCode cannot rewrite what a tool returns: a value a command prints or a file the agent may read reaches the model.
  zn adds a notice when an output holds a secret. Keep secrets in the vault.
- A user can turn the plugin off in Settings, Plugins. `zn-gate check` reads ZCode's configuration and says so.
- Code that runs as your user can edit the plugin folder, like any other plugin.
