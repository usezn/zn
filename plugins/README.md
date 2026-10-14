# Agent plugins for zn-gate

`plugins/zn-gate` packages zn-gate for coding agents in the
[Agent Plugins 1.0](https://github.com/agentplugins/agent-plugins-spec) format,
with the extra files each agent reads for hooks. One directory serves every
agent:

| Agent | What the plugin adds | How it is installed |
| --- | --- | --- |
| Claude Code | hooks, `zn-gate` and `secrets` MCP servers, skill; installs zn-gate itself | marketplace in this repository |
| Codex | `zn-gate` and `secrets` MCP servers, skill (hooks: `zn hooks install codex`) | marketplace in this repository |
| Cursor | hooks, `zn-gate` and `secrets` MCP servers, skill | plugin from this repository |
| Other Agent Plugins clients | `zn-gate` and `secrets` MCP servers, skill | the `plugins/zn-gate` directory |
| OpenCode | (no plugin manifest) | `zn hooks install opencode` |

What zn-gate can and cannot do in each agent is listed in
[docs/compat.md](https://github.com/usezn/zn/blob/v1.6.0/docs/compat.md). Codex
does not run hooks from plugins today, and Cursor loading these hooks from a
plugin has not been tested yet.

## Security model

The plugin is part of zn-gate's attack surface, so it does as little as
possible:

- **One pinned download, at install.** In Claude Code, installing the plugin
  installs zn-gate 1.6.0 into the plugin folder from the npm registry, as
  pinned by `package-lock.json` (registry integrity for every package,
  install scripts disabled). The plugin downloads nothing after that. In
  other agents you install zn-gate yourself, at an exact version, and check
  its signatures:

  ```bash
  npm install -g zn-gate@1.6.0
  npm audit signatures
  ```

- **Exact pins.** The plugin manifests, the lock file, the MCP registry entry
  and every install instruction name zn-gate 1.6.0. There is no `@latest` and
  no version range, and the plugin itself runs no package launcher such as
  `npx`.
- **Checked on every call.** Wherever it was installed, `scripts/zn-launch.js`
  requires the package to hold exactly the files in `scripts/zn-gate.lock.json` (generated
  from the published npm tarball after checking the registry's sha512
  integrity), with matching SHA-256 digests and nothing else, then runs
  zn-gate from the checked bytes in memory. Any mismatch or error fails closed.
- **No self-update.** The plugin never updates itself or zn-gate. Install new
  releases on purpose; marketplaces are added at a release tag, and
  auto-update for third-party marketplaces is off by default in Claude Code.
- **Least privilege.** The hooks and the MCP servers run zn-gate locally with
  your user's rights and send nothing over the network except the HTTP
  requests you allow per secret.

This reduces what a prompt-injected agent can do through its own tools; it is
not a sandbox. The limits (hook timeouts, the agent's environment, files Node
reads after the check, files you can write) are listed in
[the plugin README](zn-gate/README.md#limits).

`node plugins/tools/check-plugins.js` enforces the pinning rules in CI,
`node plugins/tools/test-launch.js` tests the launcher, and
`node plugins/tools/bench-launch.js packages/zn-gate` measures its cost per
hook call.

## Install

You need Node.js 20.12 or later. Claude Code installs zn-gate with the
plugin; for the other agents, first install zn-gate as shown above. Then:

### Claude Code

```bash
claude plugin marketplace add usezn/zn@v1.6.0
claude plugin install zn-gate@usezn
```

Leave auto-update off for this marketplace (the default), and upgrade on
purpose with `claude plugin update zn-gate@usezn`, which also installs the
newly pinned zn-gate. If you installed hooks before with
`zn hooks install claude-code`, remove them: `zn hooks uninstall claude-code`.

### Codex

```bash
codex plugin marketplace add usezn/zn --ref v1.6.0
```

Install `zn-gate` from the `usezn` marketplace with `/plugins`. That adds the
`zn-gate` and `secrets` MCP servers and the skill. Codex does not run hooks from plugins
(Codex 0.162.1 lists the `plugin_hooks` feature as removed), so install the
hooks with zn-gate's own installer too, then open `/hooks` in Codex and trust
them (Codex asks again whenever they change):

```bash
zn hooks install codex
```

`com.openai/hooks.json` in the plugin is kept for when Codex runs plugin hooks
again; until then the hooks installed this way call zn-gate directly, without
the plugin launcher and its file check.

### Cursor

Add the plugin from this repository (`plugins/zn-gate`) in Cursor's plugin
settings. Cursor reads `.cursor-plugin/plugin.json`, which points to its own
hook and MCP files in `cursor/`. Every Cursor hook is marked `failClosed`, so
a crash or a timeout blocks the action (stricter than
`zn hooks install cursor`, which marks only file reads and prompts).

### Other Agent Plugins clients

Point the client at the `plugins/zn-gate` directory of the `v1.6.0` tag. These
clients load the `zn-gate` and `secrets` MCP servers and the skill; hooks are agent-specific
and need one of the agents above.

### OpenCode

OpenCode loads plugins as JavaScript modules rather than from a manifest. Use
zn-gate's own installer, which writes a small plugin file that calls the same
hook runner:

```bash
zn hooks install opencode
```

That path does not go through the plugin launcher or its file check.

## MCP registry

`plugins/mcp-registry/server.json` describes the `secrets` MCP server for the
official MCP Registry. The npm package declares the matching `mcpName` in
`packages/zn-gate/package.json`, which the registry uses to verify ownership.

Registry clients start the server as `npx zn-gate@1.6.0 secrets-mcp`
(`runtimeHint`). That path does not go through the plugin launcher: it relies
on the exact version and npm's own integrity check of the tarball, not on the
plugin's file digests.

## Releasing a new version

1. Publish zn-gate `X.Y.Z` to npm with provenance.
2. Run `node plugins/tools/pin-release.js X.Y.Z` to regenerate
   `plugins/zn-gate/scripts/zn-gate.lock.json` from the published tarball.
3. Set `X.Y.Z` in `plugins/zn-gate/plugin.json`,
   `plugins/zn-gate/.claude-plugin/plugin.json`,
   `plugins/zn-gate/.cursor-plugin/plugin.json`,
   `plugins/mcp-registry/server.json`, the documentation links and the
   install instructions.
4. Run `node plugins/tools/check-plugins.js --release`; it must print OK. CI
   runs the same check on release tags and on `main`.
5. Tag the release. Release tags must be protected by a repository ruleset
   that blocks updates and deletion of `v*` tags; never move or reuse a tag.
