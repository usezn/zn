# zn-gate plugin for OpenAI Codex

zn-gate 1.13.1 as a Codex plugin: it checks every shell command, patch, MCP call and prompt for secrets before Codex runs it.

- Blocks reads and writes of secret files (`.env` with values, `~/.aws/credentials`, `~/.zn`), shell commands that read them or handle the vault, patches that touch them, MCP calls that would send a secret to a server, and prompts that contain a secret. When a tool result holds a secret, Codex gets the text with `__ZN_` tokens instead of the value.
- No account and no API key. Nothing is sent over the network.
- Ships its own copy of zn-gate (`vendor/zn-gate`). `scripts/zn-launch.js` checks it against `scripts/zn-gate.lock.json` (SHA-256 of every file of the published release) on every call and fails closed. Codex does not install npm packages for a plugin, so there is no `node_modules` to go missing.
- Needs Node.js 20.19 or later on the machine: `scripts/zn-hook.sh` looks for `node` in the PATH of the hook and in the usual install folders. When it finds none, or when anything else stops zn from running, or when Node.js does not answer within 25 seconds, it blocks instead of letting the call run. (Codex lets a call run when a hook cannot start, crashes or times out; only exit code 2 or a deny decision blocks.)

## Review the hooks first

**Installing the plugin does not turn it on.** Codex skips the hooks of a plugin until you review and trust them: open `/hooks` in Codex, read the seven zn-gate hooks and trust them. Until you do, zn-gate checks nothing, and Codex shows a warning at startup that hooks need review. After an update of the plugin Codex asks again, because it records a hash of the hook and of the whole plugin.

## Install

Add the plugin repository as a marketplace and install the plugin, then start Codex and review the hooks:

```bash
codex plugin marketplace add <this repository>
codex plugin add zn-gate@usezn
```

To remove it: `codex plugin remove zn-gate@usezn`, then `codex plugin marketplace remove usezn`. Codex keeps the trust records of the removed hooks in `~/.codex/config.toml` (`hooks.state`); they do no harm.

## Do not install the hooks twice

Codex runs the hooks of every source together and does not remove duplicates: with both this plugin and `zn hooks install codex`, every call is checked twice. Use one of them. `zn hooks uninstall codex` removes the other one (add `--project` if you installed them per project). `zn-gate check` does not look at the plugin yet: it reports the hooks written by `zn hooks install codex`.

## Limits

- Tested with the official Codex CLI 0.164.0 on Linux, with a scripted model. The hook is a POSIX shell script, so Windows is not supported by the plugin: use `zn hooks install codex` there. macOS is not tested.
- Codex loads the hooks of a plugin from `hooks/hooks.json` when `.codex-plugin/plugin.json` names none, and that is what this plugin does. In our test of Codex 0.164.0 the portable `plugin.json` with `extensions.com.openai.hooks` did not make Codex list the hooks.
- OpenAI's documentation says plugins with hooks are for plugins you install yourself and cannot be listed in its public plugin directory: this plugin comes from a marketplace repository.
- Codex cannot rewrite what a tool returns: a value a command prints or a file the agent may read reaches the model. zn replaces a result that holds a secret by its tokenized text, and the model sees that text, not the structured result.
- Codex runs matching hooks of all sources at the same time, and a hook of another plugin or of your own that rewrites a command can change what runs after zn checked it. zn notices when the command that ran is not the one it checked and withholds the output, but it cannot undo what the command did. Review the other hooks you trust.
- You can turn the hooks off in `/hooks`, with `[features] hooks = false` in `~/.codex/config.toml`, or (administrators) in `requirements.toml`; Codex shows nothing when that happens.
- This plugin carries the hooks only: it does not add zn's secrets MCP server or its skill.
- Code that runs as your user can edit the plugin folder, like any other plugin.
