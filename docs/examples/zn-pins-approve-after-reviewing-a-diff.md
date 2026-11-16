# Example: compare a changed MCP tool before you run pins approve

When the shield says that a tool of an MCP server changed, `pins approve` accepts the new version. Before you do that you need to see what is different, and `pins` shows which part changed, not the text. This page runs the whole case with a small made-up server: the change, what `pins` says, how to compare the old and the new text yourself, and the approval. It builds on the short [checklist for reviewing a pin change](mcp-pin-review-checklist.md) and on [Protect MCP servers](../shield.md#tool-pinning). All names are made up, and the paths have been shortened.

Run `pins approve` yourself, in your own terminal. It refuses to run for an AI agent or without a terminal.

## 1. The server and the first listing

The made-up server `notes-demo` is a small program in the folder `~/notes-server`. It lists its tools from a file, `tools.json`, which is kept in git, and it has two tools, `read_note` and `search_notes`. The shield wraps it as in [wrap one server](../shield.md#wrap-one-server-shield): your agent starts `npx -y zn-gate shield -- node ~/notes-server/server.js` instead of the server itself. The first time the agent lists the tools, they are pinned:

```text
[zn-shield] Pinned the tools of a new MCP server (f5e46517c8b7a1c1): node ~/notes-server/server.js
```

The 16 characters are the server key. `pins` lists it:

```bash
npx -y zn-gate pins
```

```text
MCP tool pins (~/.zn/mcp-pins, mode: warn)

  f5e46517c8b7a1c1  node ~/notes-server/server.js
      2 tool(s) pinned 2026-11-11T13:25:23.867Z
```

## 2. The server changes a tool

A new version of the server changes the description of `search_notes` and adds a parameter. The next time the agent lists the tools, the shield compares them with the pins and says:

```text
[zn-shield TOOLS CHANGED] search_notes: new or changed since the tools of this server were approved. Review them, then run in your own terminal: zn-gate pins approve f5e46517c8b7a1c1
```

In `warn` mode, the default, the changed tool is still in the list, with a notice in front of its description that tells the agent to ask you before it uses the tool. In `block` mode the tool is removed from the list.

## 3. See which part changed

```bash
npx -y zn-gate pins
```

```text
MCP tool pins (~/.zn/mcp-pins, mode: warn)

  f5e46517c8b7a1c1  node ~/notes-server/server.js
      2 tool(s) pinned 2026-11-11T13:25:23.867Z
      changed or new since then: search_notes
        search_notes: description and parameters

Review what changed, then accept it with: zn-gate pins approve <server>
```

The line under the tool says what changed: its description, its parameters, other fields, or `new tool`. It does not say how. The pins keep fingerprints, never the text of a tool, so zn-gate cannot show you the old text. You have to get the two versions from somewhere else.

## 4. Compare the old and the new text

Look where the old version still exists:

- **A server in your own repository,** as here: `git diff` shows the change.
- **A package from npm:** compare the version you ran with the new one, for example `npm diff --diff=<package>@1.0.0 --diff=<package>@1.1.0`, and read the changelog.
- **Any server:** read its source or release notes for the version change, and look at the tool in your agent.

For the made-up server the difference is this:

```diff
   {
     "name": "search_notes",
-    "description": "Search the notes for a word.",
-    "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }
+    "description": "Search the notes for a word, in every notebook.",
+    "inputSchema": { "type": "object", "properties": { "query": { "type": "string" }, "notebook": { "type": "string" } }, "required": ["query"] }
   }
```

The diff is trimmed to the lines that changed.

Ask these questions about each change:

1. **Is it what `pins` said?** `description and parameters` matches: both lines changed. A difference in a part that `pins` did not name is a reason to stop and look again.
2. **Does the new description widen what the tool does?** A tool description is read by your agent, and it decides when the agent uses the tool. "In every notebook" is a wider reach than "the notes" was. Decide whether you want the agent to search that much without asking. Text that gives the agent orders, or that mentions an address or another tool, is a reason not to approve.
3. **Does a new parameter ask for more than the tool needs?** Here `notebook` is a free text field that the agent fills in. Check what the server does with it.
4. **Is the server still the one you chose?** Compare the command line `pins` prints with your agent's MCP configuration. A changed command line is a different server, and its first list is trusted again.

If you do not accept the change, do not approve. Remove the server instead, for example with `npx -y zn-gate init --revert`, which puts back the configuration files that wrapping saved.

## 5. Approve

If the change is fine, approve it with the key that `pins` printed:

```bash
npx -y zn-gate pins approve f5e46517c8b7a1c1
```

The command asks you to type the key again. If what you type does not match, nothing changes:

```text
Type the server key again to approve: wrongkey
Not approved: what you typed did not match, so nothing was changed. Run the command again to retry.
```

Run it again and type the right key:

```text
Type the server key again to approve: f5e46517c8b7a1c1
Approved search_notes of node ~/notes-server/server.js
```

Without a terminal, the command refuses, exits with `2` and approves nothing:

```text
zn-gate pins approve runs only in your own terminal, so that an agent cannot approve tool changes. Run it there.
```

To accept the pending changes of every server at once there is `pins approve --all`. Use it only after you reviewed each server in the list.

## 6. Check again

```bash
npx -y zn-gate pins
```

```text
MCP tool pins (~/.zn/mcp-pins, mode: warn)

  f5e46517c8b7a1c1  node ~/notes-server/server.js
      2 tool(s) pinned 2026-11-11T13:25:28.608Z
```

The `changed or new since then` lines are gone, and the pinned time is updated to the time of the approval. If the tool changes again, it is flagged again.

## Related

- [Checklist: reviewing an MCP pin change before you approve it](mcp-pin-review-checklist.md)
- [Tool pinning in Protect MCP servers](../shield.md#tool-pinning)
- [`pins` in the command reference](../cli.md#pins)
- [All examples](README.md)
