# zn-gate plugin

zn-gate is a local security layer for coding agents. This plugin connects an
agent to the zn-gate package installed on your machine: hooks that keep secret
values out of tool calls, tool output and prompts, a `secrets` MCP server that
uses credentials without revealing them to the model, and a skill that
explains both to the agent.

The plugin follows the [Agent Plugins 1.0](https://github.com/agentplugins/agent-plugins-spec)
layout (`plugin.json`, `mcp.json`, `skills/`) and adds the files Claude Code
and Cursor read for hooks.

**Codex:** Codex does not run hooks from plugins (Codex 0.162.1 lists the
`plugin_hooks` feature as removed). In Codex this plugin adds the `secrets` MCP
server and the skill only. For the hooks, also run `zn hooks install codex`,
which writes them into your Codex configuration. `com.openai/hooks.json` is
kept for when Codex runs plugin hooks again.

## Requirements

- Node.js 20.12 or later.
- zn-gate **1.6.0** installed from npm. The plugin never installs, downloads or
  updates zn-gate itself. Install it once, then check the registry signatures
  of what you installed:

  ```bash
  npm install -g zn-gate@1.6.0
  npm audit signatures
  ```

  `npm audit signatures` checks the npm registry signature of every installed
  package and, for releases published with npm provenance, the attestation
  that links the package to its source commit in `usezn/zn`.

## What the plugin runs

Every hook and the MCP server run `node scripts/zn-launch.js`, a single file
with no dependencies that you can read in full. On every call it:

1. finds the zn-gate package: the directory set as
   `"plugin": {"packageDir": "..."}` in `~/.zn/config.json`, or else each
   `zn-gate` executable on your `PATH` in turn (npm global layouts);
2. requires exactly version 1.6.0;
3. reads the whole package directory and requires it to hold exactly the files
   listed in `scripts/zn-gate.lock.json`, each with the SHA-256 digest of the
   published release: no extra file or directory, no symbolic link, nothing
   missing;
4. loads zn-gate's hook runner or MCP server from the bytes it just checked,
   held in memory, with a module loader that only resolves to those files.

The lock file is generated from the published npm tarball after checking the
registry's sha512 integrity, and reviewed with each plugin release. The full
check runs on every call; `plugins/tools/bench-launch.js` in the repository
measures what that adds per hook call.

If anything fails, including an error inside zn-gate, the hooks refuse the
call or prompt and say how to fix it (exit code 2), and the MCP server does
not start. To let events pass while zn-gate is unavailable instead, set
`{"hooks": {"whenUnavailable": "allow"}}` in `~/.zn/config.json` (the file in
your account's home directory; `$HOME` does not change which file is read).

What the hooks do with each event (deny reads of credential files, replace
secret values in tool output with tokens, block prompts that contain a
secret) is described in [docs/secrets.md](https://github.com/usezn/zn/blob/v1.6.0/docs/secrets.md),
and what each agent allows in [docs/compat.md](https://github.com/usezn/zn/blob/v1.6.0/docs/compat.md).

## Limits

The plugin reduces what a prompt-injected agent can do through its own tools.
It is not a sandbox:

- **Each hook call costs more.** The full check runs on every call. In CI
  (`plugins/tools/bench-launch.js`, 478 files, 5.6 MiB) it added a median of
  15 to 27 ms per hook call on Linux and macOS and 51 to 90 ms on Windows, on
  top of the 42 to 92 ms that zn-gate's hook takes without the plugin.
- **Node.js API.** The launcher loads ES modules through
  `vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER`, which Node's documentation
  marks as experimental. If a Node.js version lacks it or changes it, the
  launcher refuses to run (hooks exit 2, the MCP server does not start).
- **Timeouts pass in Claude Code.** A hook that does not answer in 15 s is
  treated as a non-blocking error, and the call goes ahead. The Cursor hooks
  are marked `failClosed`, so Cursor blocks the call instead.
- **Refused output.** When the launcher refuses a tool-output event (the
  package was changed, zn-gate failed), it replaces the output with
  `[zn plugin: output withheld because zn could not check it]` in Claude Code,
  and for MCP tools in Cursor. Cursor cannot replace the output of its
  built-in tools, so there a refusal only reports the problem.
- **The agent's environment.** Whoever controls the environment the agent
  starts hooks with chooses which `node` runs the launcher, can preload code
  with `NODE_OPTIONS` before the launcher starts, and chooses the `PATH` used to
  find zn-gate (only an exact copy of the pinned release passes the check). The
  launcher removes `NODE_OPTIONS` and `NODE_PATH` before zn-gate starts any
  child process.
- **Files outside the in-memory load.** Child processes that zn-gate starts
  (the vault daemon, `zn run`, the stream scrubber) and the ES modules of its
  bundled dependencies are read from disk by Node after the check, so a change
  made between the check and that read is not seen.
- **Your own files.** Code that runs as you can change this plugin, the
  installed package or `~/.zn/config.json`. zn's hooks deny the agent's file
  tools and recognizable shell commands access to `~/.zn`, but a program the
  agent writes and runs is not inspected.

## What leaves your machine

Nothing, by default. The hooks and the scrubber run locally and make no
network requests. The `secrets` MCP server makes the HTTP requests the agent
asks for with `secrets_http_request`, only to hosts you allowed for each
secret (`zn secret allow NAME --host api.example.com`). zn-gate also has an
optional cloud prompt analysis (`zn analyze`, enabled only with `ZN_CLOUD=1`
and an API key, sending prompt text with secrets redacted first); the
plugin's hooks and MCP server do not use it.

## Updates

The plugin is pinned to zn-gate 1.6.0 and has no auto-update. A new zn-gate
release comes with a new plugin release that pins it, with new file digests.
Upgrade both together, and only after reading the release notes:

```bash
npm install -g zn-gate@X.Y.Z
npm audit signatures
claude plugin update zn-gate@usezn
```

## Install

Claude Code, from a marketplace pinned to the release tag:

```bash
claude plugin marketplace add usezn/zn@v1.6.0
claude plugin install zn-gate@usezn
```

Codex, Cursor and OpenCode: see [plugins/README.md](https://github.com/usezn/zn/blob/v1.6.0/plugins/README.md).

If you used `zn hooks install claude-code` before, remove those hooks so each
event is not checked twice: `zn hooks uninstall claude-code`.

## Files

| Path | Read by | Purpose |
| --- | --- | --- |
| `plugin.json`, `mcp.json`, `skills/` | Agent Plugins clients | Manifest, `secrets` MCP server, skill |
| `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json` | Claude Code | Manifest, hooks, MCP server |
| `com.openai/hooks.json` | Codex | Hooks; not run by current Codex versions (use `zn hooks install codex`) |
| `.cursor-plugin/plugin.json`, `cursor/hooks.json`, `cursor/mcp.json` | Cursor | Manifest, hooks, MCP server |
| `scripts/zn-launch.js` | all | Finds and verifies zn-gate, then runs it |
| `scripts/zn-gate.lock.json` | all | Pinned version and file digests |

## Security

Report vulnerabilities to security@usezn.com or through GitHub private
vulnerability reporting on `usezn/zn`; see
[SECURITY.md](https://github.com/usezn/zn/blob/v1.6.0/SECURITY.md).

## License

MIT
