# Example: deny one MCP tool with the shield

The shield has no deny list you can add a tool name to. The way it denies one MCP tool is [tool pinning](../shield.md#tool-pinning) in `block` mode: when the server adds a tool, or changes an approved one, and you do not approve the change, that tool is taken out of the list and every call to it is refused, while the tools that did not change keep working. This page walks through that with one made-up tool. All names and values are invented; the wrapped server is the public example server `mcp-server-fetch`.

One limit to know before you start: the first list a server returns is trusted ([Limits](../shield.md#limits)), so this denies a tool that appears or changes after the first approval. zn-gate cannot refuse a tool that was in the first list; to have fewer tools at all, keep only the tools your agent needs in the server's own configuration.

## 1. Put pinning in block mode and wrap the server

`warn` (the default) leaves a flagged tool usable. `block` removes it and refuses its calls. Set the mode in `~/.zn/config.json`:

```json
{ "mcpPinning": "block" }
```

or give the wrapped command the environment variable `ZN_MCP_PINNING=block`; the strictest of the two applies. Then wrap the server as on the [shield page](../shield.md#wrap-one-server-shield):

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "zn-gate", "shield", "--", "uvx", "mcp-server-fetch"]
    }
  }
}
```

Always keep the `--` before the server command. Restart the agent so it starts the server again. The first list is pinned as it is; here the server lists two tools, `fetch` and `render`, and both are pinned.

## 2. The server adds a tool you do not want

Later the server is updated, and on its next start the list carries a new tool `fetch-to-web`, which sends fetched pages to a web address. In the MCP log (the shield prints to stderr, and an agent app keeps stderr in its MCP log, not on your terminal) there is one line:

```text
[zn-shield TOOLS CHANGED] fetch-to-web: new or changed since the tools of this server were approved, and not available. Review them, then run in your own terminal: zn-gate pins approve 9f84d1c27a3b6e05
```

`9f84d1c27a3b6e05` stands for the 16-character key of the wrapped server; yours will differ, and `zn-gate pins` prints it. With the default `warn` mode instead of `block`, the same change only puts a notice in front of the tool's description and the tool stays usable:

```text
[zn-gate: this tool is new or changed since the user approved this server's tools; ask the user before using it.]
```

## 3. What the agent sees

In `block` mode the new tool is not in the list anymore, so the agent does not see it. If it calls `fetch-to-web` anyway, for example from a tool list it saved earlier, the shield answers the call itself with this error and nothing reaches the server:

```text
[zn-gate] The tool 'fetch-to-web' is new or changed since the user approved this server's tools, so it is not available. Ask the user to review it and run zn-gate pins approve in their own terminal.
```

The tools that did not change (`fetch` and `render`) keep working. The change is also written to the decision log with the rule `mcp_tool_changed`; look at it with `zn-gate evidence --tail 20`.

## 4. Review what changed

```bash
npx -y zn-gate pins
```

```text
MCP tool pins (/home/you/.zn/mcp-pins, mode: block)

  9f84d1c27a3b6e05  uvx mcp-server-fetch
      2 tool(s) pinned 2026-11-01T09:12:44.000Z
      changed or new since then: fetch-to-web
        fetch-to-web: new tool

Review what changed, then accept it with: zn-gate pins approve <server>
```

`pins` shows tool names, not their text. To see what the new tool does, open it in your agent or read the server's source or changelog.

## 5. Keep it denied, or approve it

- **Keep it denied.** Do nothing: do not run the approve command. Every later tool list keeps `fetch-to-web` out while it differs from the pinned definition, and calls to it keep getting the error above. If the server goes back to its approved definition, the flag clears by itself and the tool is available again.
- **Approve it.** Only if the change is one you accept, run in your own terminal (the command refuses to run under an AI agent, without an interactive terminal, or from the agent's hooks):

```bash
npx -y zn-gate pins approve 9f84d1c27a3b6e05
```

zn-gate asks you to type the server key again, then prints:

```text
Approved fetch-to-web of uvx mcp-server-fetch
```

After that the tool is pinned as the server now lists it, and it works on the next list.

## What this example does not cover

- A tool that was in the first list cannot be denied this way; that list is trusted.
- Pinning covers tool definitions, not the server's code. Pin the package version in your MCP configuration, for example `npx -y some-tool@1.4.2`, and review each new version.
- With `--shadow` the shield only logs: it removes nothing and refuses nothing.

## More

- [Protect MCP servers: shield, shadow mode and tool pins](../shield.md)
- [`shield` in the command reference](../cli.md#shield)
- [`pins` in the command reference](../cli.md#pins)
- [What the decision log is](evidence-example.md)
