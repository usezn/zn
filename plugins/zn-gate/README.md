# zn-gate plugin

zn-gate is a local security layer for coding agents. This plugin connects an
agent to the zn-gate package installed on your machine: hooks that keep secret
values out of tool calls, tool output and prompts, a `secrets` MCP server that
uses credentials without revealing them to the model, and two skills that
explain both to the agent.

The plugin follows the [Agent Plugins 1.0](https://github.com/agentplugins/agent-plugins-spec)
layout (`plugin.json`, `mcp.json`, `skills/`) and adds the files Claude Code,
Codex and Cursor read for hooks.

## Requirements

- Node.js 18 or later.
- zn-gate **1.6.0** installed from npm. The plugin never installs, downloads or
  updates zn-gate itself. Install it once, then check the registry signatures
  and provenance attestations of what you installed:

  ```bash
  npm install -g zn-gate@1.6.0
  npm audit signatures
  ```

  `npm audit signatures` checks the npm registry signature of every installed
  package and, for releases published with npm provenance, the attestation
  that links the package to its source commit in `usezn/zn`. The plugin then
  checks every file of the installed package against digests taken from the
  published release (see below).

## What the plugin runs

Every hook and the MCP server run `node scripts/zn-launch.js`, a single file
with no dependencies that you can read in full. It:

1. finds the zn-gate package through the `zn-gate` executable on your `PATH`,
   or through `"plugin": {"packageDir": "..."}` in `~/.zn/config.json`;
2. checks that it is exactly version 1.6.0;
3. checks the SHA-256 digest of every file of the package against
   `scripts/zn-gate.lock.json`, which is generated from the published npm
   release and reviewed with each plugin release;
4. only then loads zn-gate's hook runner or MCP server in the same process.

The full digest check runs when a session starts and whenever the size,
modification time or inode of any zn-gate file changed since the last full
check (recorded in `~/.zn/plugin-verified.json`), so ordinary hook calls do not
hash the whole package again.

If any check fails, hooks refuse the call and say how to fix it (fail closed),
and the MCP server does not start. To let events pass while zn-gate is
unavailable, set `{"hooks": {"whenUnavailable": "allow"}}` in
`~/.zn/config.json`; agents cannot write that file.

What the hooks do with each event (deny reads of credential files, replace
secret values in tool output with tokens, block prompts that contain a
secret) is described in [docs/secrets.md](https://github.com/usezn/zn/blob/main/docs/secrets.md),
and what each agent allows in [docs/compat.md](https://github.com/usezn/zn/blob/main/docs/compat.md).

## What leaves your machine

Nothing, by default. The hooks and the scrubber run locally and make no
network requests. The `secrets` MCP server makes the HTTP requests the agent
asks for with `secrets_http_request`, only to hosts you allowed for each
secret (`zn secret allow NAME --host api.example.com`). The optional cloud
detector of zn-gate is off unless you set `ZN_CLOUD=1` and an API key; this
plugin never sets either.

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

Codex, Cursor and OpenCode: see [plugins/README.md](../README.md).

If you used `zn hooks install claude-code` before, remove those hooks so each
event is not checked twice: `zn hooks uninstall claude-code`.

## Files

| Path | Read by | Purpose |
| --- | --- | --- |
| `plugin.json`, `mcp.json`, `skills/` | Agent Plugins clients | Manifest, `secrets` MCP server, skills |
| `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json` | Claude Code | Manifest, hooks, MCP server |
| `com.openai/hooks.json` | Codex | Hooks (Codex asks you to trust them first) |
| `.cursor-plugin/plugin.json`, `cursor/hooks.json` | Cursor | Manifest and hooks |
| `scripts/zn-launch.js` | all | Finds and verifies zn-gate, then runs it |
| `scripts/zn-gate.lock.json` | all | Pinned version and file digests |

## Security

Report vulnerabilities to security@usezn.com or through GitHub private
vulnerability reporting on `usezn/zn`; see
[SECURITY.md](https://github.com/usezn/zn/blob/main/SECURITY.md).

## License

MIT
