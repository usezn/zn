# Agent plugins for zn-gate

`plugins/zn-gate` packages zn-gate for coding agents in the
[Agent Plugins 1.0](https://github.com/agentplugins/agent-plugins-spec) format,
with the extra files each agent reads for hooks. One directory serves every
agent:

| Agent | What the plugin adds | How it is installed |
| --- | --- | --- |
| Claude Code | hooks, `secrets` MCP server, skills | marketplace in this repository |
| Codex | hooks (after you trust them), `secrets` MCP server, skills | marketplace in this repository |
| Cursor | hooks, `secrets` MCP server, skills | plugin from this repository |
| Other Agent Plugins clients | `secrets` MCP server, skills | the `plugins/zn-gate` directory |
| OpenCode | (no plugin manifest) | `zn hooks install opencode` |

What zn-gate can and cannot do in each agent is listed in
[docs/compat.md](../docs/compat.md).

## Security model

The plugin is part of zn-gate's attack surface, so it is built to do as
little as possible:

- **Nothing is downloaded or installed by the plugin.** You install zn-gate
  yourself, at an exact version, and check its signatures:

  ```bash
  npm install -g zn-gate@1.6.0
  npm audit signatures
  ```

- **Exact pins everywhere.** The plugin manifests, the lock file, the MCP
  registry entry and every install instruction name zn-gate 1.6.0. There is no
  `@latest`, no version range and no package launcher such as `npx`.
- **Verified before it runs.** `scripts/zn-launch.js` checks the installed
  package's version and the SHA-256 digest of each of its files against
  `scripts/zn-gate.lock.json`, generated from the published npm tarball after
  checking the registry's sha512 integrity. Any mismatch fails closed.
- **No self-update.** The plugin never updates itself or zn-gate. Install new
  releases on purpose; marketplaces are added at a release tag, and
  auto-update for third-party marketplaces is off by default in Claude Code.
- **Least privilege.** The hooks and the MCP server run zn-gate locally with
  your user's rights, read only what zn-gate needs, and send nothing over the
  network except the HTTP requests you allow per secret.

`node plugins/tools/check-plugins.js` enforces the pinning rules in CI.

## Install

First install zn-gate as shown above. Then:

### Claude Code

```bash
claude plugin marketplace add usezn/zn@v1.6.0
claude plugin install zn-gate@usezn
```

Leave auto-update off for this marketplace (the default), and upgrade on
purpose with `claude plugin update zn-gate@usezn` after installing the new
zn-gate release. If you installed hooks before with
`zn hooks install claude-code`, remove them: `zn hooks uninstall claude-code`.

### Codex

```bash
codex plugin marketplace add usezn/zn --ref v1.6.0
```

Install `zn-gate` from the `usezn` marketplace with `/plugins`, then open
`/hooks` and trust the zn-gate hooks: Codex does not run plugin hooks until
you do, and asks again whenever they change.

### Cursor

Add the plugin from this repository (`plugins/zn-gate`) in Cursor's plugin
settings, or install it from the Cursor Marketplace once it is listed there.

### Other Agent Plugins clients

Point the client at the `plugins/zn-gate` directory of the `v1.6.0` tag. These
clients load the `secrets` MCP server and the skills; hooks are agent-specific
and need one of the agents above.

### OpenCode

OpenCode loads plugins as JavaScript modules rather than from a manifest. Use
zn-gate's own installer, which writes a small plugin file that calls the same
hook runner:

```bash
zn hooks install opencode
```

## Continuous integration

`zn audit` also runs in GitHub Actions through the zn-gate action at the root
of this repository. Pin it by the full commit SHA that the release tag points
to, not by the tag; tags can be moved, commits cannot. Look the SHA up with
`git ls-remote https://github.com/usezn/zn refs/tags/v1.6.0` and write it in
place of the placeholder:

```yaml
- uses: usezn/zn@<commit-sha-of-v1.6.0> # v1.6.0
```

See the action's README for its inputs and the permissions it needs.

## MCP registry

`plugins/mcp-registry/server.json` describes the `secrets` MCP server for the
official MCP Registry. The npm package declares the matching `mcpName` in
`packages/zn-gate/package.json`, which the registry uses to verify ownership.

## Releasing a new version

1. Publish zn-gate `X.Y.Z` to npm.
2. Run `node plugins/tools/pin-release.js X.Y.Z` to regenerate
   `plugins/zn-gate/scripts/zn-gate.lock.json` from the published tarball.
3. Set `X.Y.Z` in `plugins/zn-gate/plugin.json`,
   `plugins/zn-gate/.claude-plugin/plugin.json`,
   `plugins/zn-gate/.cursor-plugin/plugin.json`,
   `plugins/mcp-registry/server.json` and the install instructions.
4. Run `node plugins/tools/check-plugins.js --release`; it must print OK.
5. Tag the release; never move or reuse a tag.
