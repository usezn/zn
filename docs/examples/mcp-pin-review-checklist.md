# Checklist: reviewing an MCP pin change before you approve it

When the shield prints `[zn-shield TOOLS CHANGED]`, a tool of a pinned MCP server changed or is new since you last approved that server's tools. Approving is your decision, not your agent's: run every command in your own terminal. In `warn` mode (the default) the agent still sees the changed tool with a notice in front of its description; in `block` mode the tool is removed from the list and a call to it returns an error. All values in this page are made up.

1. **See what changed.**

   ```bash
   npx -y zn-gate pins
   ```

   `pins` (or `pins list`) lists each pinned server with its key, its command line, how many tools are pinned and when, and the names of the tools that changed or are new since then, each with what changed: its description, its parameters (the input and output schema, including every parameter description), other fields (annotations and the like), or `new tool`. Pins written by an older version say `whole tool` until the next approval. `pins` shows tool names, not their text.

2. **Check that it is still the same server.**

   Pins belong to a server's command line: the server key is computed from the program and its arguments. A changed command line — for example a new package version, or `node server.js` in another project — is a different server, and its first list is trusted again. Compare the command line that `pins` prints with the server in your agent's MCP configuration.

3. **Look at the tool itself.**

   Open the tool in your agent, or read the server's source or changelog. Compare what you find with what `pins` reported: a changed description, changed parameters, changed other fields, or a `new tool`.

4. **Decide what to do with each flagged tool.**

   A changed or new tool can be approved. A server that lists more than one tool with the same name, or a tool without a valid name, can never be approved: the server has to fix its tool list. If a flagged tool went back to its pinned definition, the flag clears by itself. If you do not accept the change, do not approve: remove the server instead, for example with `npx -y zn-gate init --revert`, which restores the original configuration files from the backups that wrapping wrote.

5. **Approve.**

   ```bash
   npx -y zn-gate pins approve <server-key>
   ```

   Use the key that `pins` prints. To accept the changes of every server with pending changes, use `npx -y zn-gate pins approve --all`. zn-gate asks you to type the server key (or `all`) again before it approves; if what you typed does not match, nothing changes and you can run the command again. Exit codes: `0` done, `2` wrong usage, no terminal, an agent running it, or the approval was not confirmed.

6. **Check the pin again.**

   ```bash
   npx -y zn-gate pins
   ```

   After approval the changed and new tools are pinned as the shield last saw them, and they work again the next time the agent lists the server's tools. The server should no longer have tools in the changed list. If a tool changes again later, it is flagged again.

Every change is also written to the decision log (`~/.zn/evidence.jsonl`; check it with `npx -y zn-gate evidence --verify`). Two limits to keep in mind: the first list a server returns is trusted, so pinning cannot catch a list that was already harmful — pin the package version in your MCP configuration, for example `npx -y some-tool@1.4.2`, and review each new version; and pinning covers tool definitions, not the server's code.

## Related

- [Protect MCP servers: shield, shadow mode and tool pins](../shield.md)
- [`pins` in the CLI reference](../cli.md#pins)
- [Set up zn-gate, preview the steps, remove it](init-and-uninstall.md)
