# Example: reviewing a changed tool description

When a server you wrapped with `zn-gate shield` changes one of its tools, the shield tells you. This page runs a fake, harmless MCP server through the shield three times and shows what each warning looks like, what your agent sees, and what to do. Every description is made up and ordinary. The full reference is [Protect MCP servers](../shield.md); the commands are in [`shield`](../cli.md#shield) and [`pins`](../cli.md#pins).

Run every command in your own terminal, not through your agent. The `[zn-shield ...]` lines go to stderr: in an agent app they land in the MCP log of the app, not in your terminal.

## 1. The first time: nothing to review

The server `notes` offers two tools. The shield has never seen it, so it trusts the list and remembers a fingerprint of each tool:

```text
[zn-shield] Pinned the tools of a new MCP server (ccb2c77cff3e957e): node /home/you/notes-server.js
```

```bash
npx -y zn-gate pins
```

```text
MCP tool pins (/home/you/.zn/mcp-pins, mode: warn)

  ccb2c77cff3e957e  node /home/you/notes-server.js
      2 tool(s) pinned 2026-11-11T13:53:05.393Z
```

The first list a server returns is trusted as it is. This is the moment to check that you know the server. See [What gets pinned](../shield.md#what-gets-pinned).

## 2. `TOOLS CHANGED`: a description changed and a tool is new

Later the server ships an update. The `take_notes` description now ends with "Notes are kept for 30 days.", and there is a new tool, `export_notes`. The shield prints:

```text
[zn-shield TOOLS CHANGED] take_notes, export_notes: new or changed since the tools of this server were approved. Review them, then run in your own terminal: zn-gate pins approve ccb2c77cff3e957e
```

The warning names the tools, but not what changed in them. Your agent sees the two flagged tools with a notice in front of their descriptions, and the third one as before:

```text
take_notes: [zn-gate: this tool is new or changed since the user approved this server's tools; ask the user before using it.] Saves a short note to your notes list. Notes are kept for 30 days.
list_notes: Lists the saved notes.
export_notes: [zn-gate: this tool is new or changed since the user approved this server's tools; ask the user before using it.] Writes all notes to a local file chosen by the user.
```

That is `warn` mode, the default: the tool stays usable and the notice relies on your agent reading it. To find out what changed, ask for the pins:

```bash
npx -y zn-gate pins
```

```text
  ccb2c77cff3e957e  node /home/you/notes-server.js
      2 tool(s) pinned 2026-11-11T13:53:05.393Z
      changed or new since then: take_notes, export_notes
        take_notes: description
        export_notes: new tool

Review what changed, then accept it with: zn-gate pins approve <server>
```

The words after each tool tell you where to look:

| `pins` says | What changed | What to look at |
| --- | --- | --- |
| `description` | The text that tells the agent what the tool does | Read the new text. Does it say more than what the tool does? Does it mention files, addresses or other tools? |
| `parameters` | The input or output schema, including every parameter description | Compare the parameters with what you expect. A new parameter, or a new instruction in a parameter description, deserves a close read. |
| `other fields` | Annotations and the like | Usually harmless, but check them in the changelog. |
| `new tool` | The tool was not in the pinned list | Do you want your agent to have it? |
| `whole tool` | Pinned by an older version, so the part is unknown | Review the whole tool. |

`pins` shows tool names and the kind of change, never the text itself. Read the text in your agent, or in the server's changelog or source. Here the change is a retention note and a new export tool, which is what the update was meant to bring, so it is fine to approve.

## 3. A second change stays flagged

If the server changes again before you approved, the flag stays, and `pins` names every kind of change since the pinned version. After the author also edited a parameter description of `take_notes`, `pins` says:

```text
        take_notes: description and parameters
        export_notes: new tool
```

Approving takes the last version the shield saw, so review that one.

## 4. `block` mode removes the tool

If you set `ZN_MCP_PINNING=block` (or `"mcpPinning": "block"` in `~/.zn/config.json`), the changed and new tools are not in the list at all, and the warning says so:

```text
[zn-shield TOOLS CHANGED] take_notes, export_notes: new or changed since the tools of this server were approved, and not available. Review them, then run in your own terminal: zn-gate pins approve ccb2c77cff3e957e
```

Your agent sees only `list_notes`. A call to a tool that is not approved is refused, even from a list the agent saved earlier. See [Modes](../shield.md#modes).

## 5. `TOOL SHADOWING`: the same name on two servers

Add a second server, `other`, that has a tool named `list_notes` as well. When the shield sees its list it prints:

```text
[zn-shield TOOL SHADOWING] list_notes: has the same name as an approved tool of another MCP server. The agent may call the wrong one. Check that both servers are yours.
```

This is a warning, not a block: the same name on two servers can be legitimate. Check that both servers are ones you installed on purpose, and decide which one you want your agent to use. Only approved tools of your other servers count as a reference, which is why `take_notes` (changed, not approved) was not named. See [Tool shadowing](../shield.md#tool-shadowing).

## 6. Approve, or remove the server

When you accept the change, run this in your own terminal. Your agent cannot do it: without a terminal, or under an agent, the command answers `zn-gate pins approve runs only in your own terminal, so that an agent cannot approve tool changes. Run it there.` and exits `2`.

```bash
npx -y zn-gate pins approve ccb2c77cff3e957e
```

zn-gate asks you to type the server key again. Afterwards `npx -y zn-gate pins` shows no changed tools for that server. If you do not accept the change, do not approve: remove the server, for example with `npx -y zn-gate init --revert`. The steps for a careful review are in [Reviewing an MCP pin change before you approve it](mcp-pin-review-checklist.md).

## Other lines you may see

These come up when a description or a message is not ordinary. This page does not show them, because its examples are all ordinary text:

- `[zn-shield BLOCKED TOOL DESCRIPTION]` and `[zn-shield BLOCKED PARAMETER DESCRIPTION]`: the shield found hidden instructions in a tool or parameter description and neutralized them before your agent read them. The line names the tool and the rule. In shadow mode the text is passed on and the line is only a record.
- `[zn-shield TOOLS REFUSED]`: the server lists two tools with the same name, or a tool without a valid name. These can never be approved: the server has to fix its list.

## Where to read more

- [Protect MCP servers: shield, shadow mode and tool pins](../shield.md)
- [`pins`](../cli.md#pins) in the command line reference
- [Shield walkthrough: wrap an MCP server, from shadow to enforce](shield-walkthrough.md)
- [Reviewing an MCP pin change before you approve it](mcp-pin-review-checklist.md)
