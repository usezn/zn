# Example: pins when you add a new MCP server

This page follows one new MCP server through its first pinning: what to look at before the shield sees its tools for the first time, what `zn-gate pins` shows afterwards, and what happens when the server later adds a tool. The server and its tools are made up. For what to compare when a tool changes, read [Checklist: reviewing an MCP pin change before you approve it](mcp-pin-review-checklist.md). Run every command in your own terminal.

The first list of tools that a server returns is pinned as it is, without a question to you. This is called trust on first use, and it is why the review in step 1 comes first: pinning cannot tell that the first list was already harmful. `pins approve` is for the changes that come later.

## 1. Before the first pinning

Do these checks before you let an agent start the server through the shield:

1. **Know where the server comes from.** Read its page or source, and check who publishes it.
2. **Pin the version in the command.** A changed command line is a different server, and its first list is trusted again. With `npx -y some-tool@1.4.2` a new release is not picked up by accident.
3. **Read its tools.** Open the list of tools in the server's documentation or source, and read each description and each parameter description. A tool description that tells the agent to send data somewhere, or to ignore your instructions, is a reason to stop.
4. **Keep it small.** Does the server need every tool it offers? One that you do not need is one more description your agent reads.
5. **Start in shadow mode if you are unsure.** `zn-gate init --shadow` only watches and records (see [Shield walkthrough](shield-walkthrough.md)).

## 2. See that nothing is pinned yet

```bash
npx -y zn-gate pins
```

```text
No MCP server has been pinned yet. Servers are pinned the first time `zn-gate shield` sees their tools.
```

## 3. The first run through the shield

Your agent starts the server through the shield, for example with `zn-gate shield -- node example-server.js` (`init --wrap-mcp` writes this for you). When the server returns its tools for the first time, the shield writes one line to its error output and pins them:

```text
[zn-shield] Pinned the tools of a new MCP server (0692aec978f17d52): node example-server.js
```

The number in brackets is the server key. It is computed from the command line, so yours will differ.

## 4. List the pin

```bash
npx -y zn-gate pins
```

```text
MCP tool pins (~/.zn/mcp-pins, mode: warn)

  0692aec978f17d52  node example-server.js
      2 tool(s) pinned 2026-11-11T14:49:19.602Z
```

It shows the key, the command line, how many tools are pinned and when. There is no "changed or new" line, because nothing has changed yet. This is the state you want to compare against later.

## 5. When the server adds a tool

Say a later version of the server returns a third tool, `export_notes`. The shield flags it on the next run and the agent sees a notice in front of that tool's description (in the default `warn` mode):

```text
[zn-shield TOOLS CHANGED] export_notes: new or changed since the tools of this server were approved. Review them, then run in your own terminal: zn-gate pins approve 0692aec978f17d52
```

```bash
npx -y zn-gate pins
```

```text
MCP tool pins (~/.zn/mcp-pins, mode: warn)

  0692aec978f17d52  node example-server.js
      2 tool(s) pinned 2026-11-11T14:49:19.602Z
      changed or new since then: export_notes
        export_notes: new tool

Review what changed, then accept it with: zn-gate pins approve <server>
```

Review the new tool with the [checklist](mcp-pin-review-checklist.md) before you go on.

## 6. Approve it, if you accept it

```bash
npx -y zn-gate pins approve 0692aec978f17d52
```

zn-gate asks you to type the server key again. Then it prints:

```text
Type the server key again to approve: 0692aec978f17d52
Approved export_notes of node example-server.js
```

`pins` now shows `3 tool(s) pinned` and no changed line. Approving needs a person at a terminal. From a script, or with no terminal, it refuses and exits with `2`:

```text
zn-gate pins approve runs only in your own terminal, so that an agent cannot approve tool changes. Run it there.
```

## Related

- [Checklist: reviewing an MCP pin change before you approve it](mcp-pin-review-checklist.md)
- [Shield walkthrough: wrap an MCP server, from shadow to enforce](shield-walkthrough.md)
- [Protect MCP servers: shield, shadow mode and tool pins](../shield.md#tool-pinning)
- [`pins` in the CLI reference](../cli.md#pins)
