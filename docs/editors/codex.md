# OpenAI Codex

Set up zn-gate in the OpenAI Codex CLI: install its hooks, and what the Codex plugin build is.

## Install the hooks

In your own terminal, not through your agent:

```bash
npx -y zn-gate init
```

`init` looks for Codex (a `~/.codex` folder, or a `codex` program on your `PATH`), shows each step and asks before it runs one. To do just this step with zn-gate installed (`npm install -g zn-gate`):

```bash
zn hooks install codex
```

This writes zn's hooks to `~/.codex/hooks.json` for your user (add `--project` for `<repo>/.codex/hooks.json`), next to anything already there, and keeps a backup of the file. **Then open Codex and trust the hooks in `/hooks`:** Codex does not run a hook until you have reviewed it, and asks again when a hook changes. `zn hooks uninstall codex` removes zn's hooks.

Then run `npx -y zn-gate check` to see that the hook works on your machine.

## The Codex plugin

A Codex plugin build of zn-gate is ready. The steps to add it in Codex will be published with its plugin repository. Until then the supported way to use zn-gate in Codex is `zn hooks install codex`, above.

What the plugin is, so you know what to expect when it is published:

- It has the same hooks as `zn hooks install codex`. It carries its own copy of zn-gate, pinned to one release and checked against the SHA-256 of every file of the published release on each call, so there is nothing to download and nothing to go missing. It needs no account and no API key, and sends nothing over the network.
- **Its hooks need your approval too.** Codex skips the hooks of a plugin until you review and trust them in `/hooks`, and asks again after every update of the plugin. Installing the plugin is not enough: until you trust the hooks, nothing is checked.
- **Hooks can be turned off.** Hooks stop running, the plugin's and those of `zn hooks install codex` alike, when they are turned off in `/hooks`, with `[features] hooks = false` in `~/.codex/config.toml`, or by an administrator in `requirements.toml`. Codex shows nothing when that happens.
- Its hook is a POSIX shell script. Tested on Linux with the Codex CLI 0.164.0; macOS is not tested. Not Windows: use `zn hooks install codex` there. It needs Node.js 20.19 or later, and blocks the call when it finds none, when anything fails, or when Node.js does not answer within 28 seconds (Codex lets a call run when a hook cannot start or times out).
- Use the plugin or `zn hooks install codex`, not both: Codex does not remove duplicate hooks, so every call would be checked twice. `zn-gate check` does not look at the plugin yet.
- It carries the hooks only, not zn's secrets MCP server.

More detail is in [agent compatibility](../compat.md) and in the [threat model](../threat-model.md).

## Codex documentation

- Hooks: <https://learn.chatgpt.com/docs/hooks>
- Plugins: <https://developers.openai.com/plugins/build/plugins>
