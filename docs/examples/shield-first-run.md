# Example: first run of the shield

A short walk-through of `zn-gate shield` the first time you use it: wrap one MCP server, try it in shadow mode, see what it prints, and take it out again. The full reference is on the [shield page](../shield.md) and in the [command reference](../cli.md#shield). The shield is part of the npm package; the Python package does not have it. All names and values here are made up or are public example servers.

## What it does

`shield` is a local proxy. Your agent starts it instead of the MCP server, and the shield starts the real server and sits between the two. It checks the tool list, the arguments of each tool call and the tool output, and it pins each tool the first time it sees it. Everything runs on your machine and nothing is sent anywhere. Each decision is added to the local decision log.

## 1. Pick a local server and wrap it in shadow mode

The shield wraps a program it starts, so it works with local (stdio) servers. Put `--shadow` before the `--` that starts the server:

```bash
npx -y zn-gate shield --shadow -- uvx mcp-server-fetch
```

You normally do not type this in a terminal. The command is what your agent runs. In the agent's MCP configuration, set the command to `npx` and put the shield in front of the original command:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "zn-gate", "shield", "--shadow", "--", "uvx", "mcp-server-fetch"]
    }
  }
}
```

Always keep the `--`. To wrap every local server in your agent configs in one step instead, see [`init --shadow`](../shield.md#wrap-all-your-servers-at-once-init---wrap-mcp); it writes a backup of each file first.

In shadow mode the shield watches and records but does not change anything: a call it would refuse is still sent on, and tool output reaches the agent untouched, secrets included. Use it to see what zn-gate would do, not as protection.

## 2. What you see on the first start

The shield prints to stderr, and an agent app keeps stderr in its MCP log, so look there rather than in your terminal. The first time the shield sees the tool list of a server, it pins the tools and prints one line:

```text
[zn-shield] Pinned the tools of a new MCP server (<server-key>): mcp-server-fetch
```

`<server-key>` is a 16-character code that zn-gate computes from the program and its arguments. Add `--verbose` before the `--` if you want a line for each request the shield inspects.

Other lines that can follow, with what they mean:

| Line starts with | Meaning |
| --- | --- |
| `[zn-shield BLOCKED REQUEST]` | A tool call carried an injection in its arguments. In shadow mode it was still sent on. |
| `[zn-shield BLOCKED RESPONSE]` | Tool output carried an injection. In shadow mode it was passed on. |
| `[zn-shield TOOLS CHANGED]` | A tool is new or differs from the pinned one. The line ends with the `pins approve` command to run. |

If the program after `--` is not installed or not on your `PATH`, the shield exits with code 1 and says so, for example `zn-gate shield: could not start 'uvx': it is not installed or not on your PATH.` followed by how to install it. If you give no command at all, it prints `Error: Please provide command to wrap: zn-gate shield -- <command> [args...]` and exits with code 1.

## 3. Look at the pins and the decision log

```bash
npx -y zn-gate pins
npx -y zn-gate evidence --tail 20
```

`pins` lists each pinned server with its key, its command line and how many tools are pinned. Before any server has been pinned it prints `No MCP server has been pinned yet. Servers are pinned the first time zn-gate shield sees their tools.` `evidence --tail 20` shows the last 20 decisions; `evidence --verify` checks the hash chain of the log.

If a tool changes later, review it first. Only then approve it, in your own terminal (the command refuses to run under an AI agent):

```bash
npx -y zn-gate pins approve <server-key>
```

## 4. Turn the protection on

When the log looks right, remove `--shadow` from the `args` so the shield enforces:

```json
"args": ["-y", "zn-gate", "shield", "--", "uvx", "mcp-server-fetch"]
```

Restart the agent so it starts the server again with the new command.

## 5. Stop or undo it

- **Stop one server.** The shield ends when the wrapped server ends, with the server's exit code. An agent app starts and stops both, so closing the agent or disabling the server in its MCP settings stops the shield too.
- **Take the shield out of one server.** Put the original command back in the configuration (`uvx` with `mcp-server-fetch` in this example) and restart the agent.
- **Undo `init`.** If `init` wrapped your servers, `npx -y zn-gate init --revert` puts back the configuration files it saved first. `npx -y zn-gate uninstall --dry-run` shows everything zn-gate set up before you remove it. See [remove zn-gate](../uninstall.md).

## More

- [Protect MCP servers: shield, shadow mode and tool pins](../shield.md)
- [`shield` in the command reference](../cli.md#shield)
- [`pins` in the command reference](../cli.md#pins)
