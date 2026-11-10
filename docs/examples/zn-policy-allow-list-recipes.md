# Examples: three narrow ways to allow a blocked action

When `zn why` names a command that lets an action through, the allow is always narrow: it covers one secret, one program or one MCP tool. This page gives one recipe for each of the three kinds of allow that exist, and the `zn why` output that leads to it. All names, hosts and values are made up. Run every command in your own terminal, not through your agent. For the whole flow of `zn why`, read [Allow a blocked action after zn why](zn-why-allow-command.md).

## Which block gets which allow

| `zn why` shows (rule) | Command it gives | Recipe |
| --- | --- | --- |
| A secret value, in a prompt, a command or a tool call (`hook-pre_tool-secret` and the other `secret:` rules) | `zn secret set NAME` | [Recipe 1](#recipe-1-a-secret-for-one-host) and [Recipe 2](#recipe-2-a-secret-for-one-program) |
| An MCP tool that is new or changed since you approved it (`mcp_tool_changed`) | `zn pins approve <server>` | [Recipe 3](#recipe-3-a-changed-mcp-tool) |
| A file path that usually holds secrets (`path:` rules, such as `.env` or `~/.ssh`) | None: "No command lets this through." | [What has no allow](#what-has-no-allow) |

The rule table behind `zn why` (`packages/zn-gate/lib/rule-explanations.js`) prints only two commands: `secret set NAME` and `pins approve`. The host and program scopes of recipes 1 and 2 are options of `secret set`, which the table does not show.

## Recipe 1: a secret for one host

`zn why` for a secret value found in a tool call:

```text
zn blocked this at 2026-11-09T09:20:00.000Z (UTC).
  Rule:    hook-pre_tool-secret - A secret value in what zn checked before the agent ran a tool
  ...
To go on, run this in your own terminal (not through your agent):
  zn secret set NAME
```

Store the value for one host. `NAME` is a name you choose, and `--host` takes the exact host the value may be sent to:

```bash
zn secret set EXAMPLE_API_KEY --host api.example.test
```

zn asks for the value at a hidden prompt. Then the agent writes `__ZN_EXAMPLE_API_KEY__` where the key goes, and the `secrets` MCP server sends the real value only to `api.example.test`.

Limits to know:

- The host must match exactly. `api.example.test` does not allow `x.api.example.test`. An entry without a port allows every port of that host; add `:443` to allow only HTTPS ([Egress allowlist for `zn run`](../secrets.md#egress-allowlist-for-zn-run) explains the same rule for ports).
- Only a secret in `proxy` mode (the default with `--host`) is sent over HTTP. A secret for a program is never sent over HTTP, even if it also has an allowed host ([docs/secrets.md](../secrets.md#5-let-the-agent-call-an-api)).

Check what you allowed, without the value:

```bash
zn secret list
```

## Recipe 2: a secret for one program

`zn why` for the same kind of block, when the value is needed by a program and not by a web request:

```text
  Rule:    hook-pre_tool-secret - A secret value in what zn checked before the agent ran a tool
  ...
  zn secret set NAME
```

Store the secret under the name the program reads, and allow one command for it. `psql` reads its password from `PGPASSWORD`:

```bash
zn secret set PGPASSWORD --command "psql"
```

The agent then runs the program through `zn run`, naming the secret with `--secrets`:

```bash
zn run --secrets PGPASSWORD -- psql -h db.example.test -U app -c "select 1"
```

The first time this pair of secret and command runs, zn asks you to confirm it in the vault's own prompt, which shows the exact program. The agent cannot answer that prompt ([How `zn run` confirms a first use](../secrets.md#4-let-a-command-use-a-secret)).

Limits to know:

- A command entry is a prefix. `--command psql` allows any `psql` arguments. For a narrower allow, name more words: `--command "npm run migrate"` allows `npm run migrate` (with any further arguments) and no other `npm` command.
- Do not allow an interpreter such as `node`, `python` or `npm` for a secret. Such a program runs any code it is given, so every script it runs could read the value. zn warns you when you allow one.

## Recipe 3: a changed MCP tool

An MCP server you approved earlier changed one of its tools. `zn why` shows:

```text
  Rule:    mcp_tool_changed - An MCP tool is new or different since you approved it
  ...
To go on, run this in your own terminal (not through your agent):
  zn pins approve my-server@1
```

First read what changed, then approve:

```bash
zn pins
zn pins approve my-server@1
```

`pins approve` asks you to type the server key again. If the name in the log is not a plain name, `zn why` prints `<server>`; take the real name from `zn pins`. The note that `zn why` prints also says that a server listing the same tool twice, or a tool without a valid name, cannot be approved until the server is fixed.

## What has no allow

For a path that usually holds secrets, `zn why` says:

```text
  Rule:    path:sensitive_file - Text that points at a file that usually holds passwords or keys
  ...
No command lets this through.
```

This is by design: `packages/zn-gate/lib/rule-explanations.js` gives the `path:` rules no command, and `zn why` shows "Who decides" instead. Do not look for an allow in your settings for these. If a secret has to be kept in such a file, store the value in the vault with `zn secret set` and leave only a marker in the file. For a `.env` file, `zn env shadow` does this for you ([Keep a secret out of the agent](../secrets.md)).

Two allow lists in `~/.zn/config.json` are not printed by `zn why`, because they are set up in advance and not after a block: `hooks.packageInstallAllow` for package names you trust ([Packages your agent installs](../package-install-check.md)), and `hooks.egressAllowHosts` for hosts that are not checked ([Egress check](../egress-check.md)). Both take exact names; neither covers a path rule.

## Related

- [Allow a blocked action after zn why](zn-why-allow-command.md): the full flow, with exit codes.
- [Keep a secret out of the agent](keep-a-secret-out-of-the-agent.md): one fake secret from start to removal.
- [Command line reference: why](../cli.md#why).
