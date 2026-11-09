# Shield walkthrough: wrap an MCP server, from shadow to enforce

This page wraps one fake MCP server with `zn-gate shield`, first in shadow mode, which only watches and records, then in enforce mode, and finally puts the original configuration back. The server, the file and every value are made up. The full reference is [Protect MCP servers](../shield.md); the commands are in [shield](../cli.md#shield) and [pins](../cli.md#pins).

Run every command in your own terminal, not through your agent.

## The example setup

The MCP configuration of one of your agents lists one local server, started from a file in the project:

```json
{
  "mcpServers": {
    "example-server": {
      "command": "node",
      "args": ["example-server.js"]
    }
  }
}
```

## 1. See what would change

```bash
npx -y zn-gate init --dry-run
```

`init --wrap-mcp` finds the MCP servers in known agent configs and wraps them with `shield`. `--dry-run` shows what would change and changes nothing.

## 2. Wrap in shadow mode

```bash
npx -y zn-gate init --shadow
```

zn-gate writes a backup of each config file it changes and rewrites each local server as a `shield` command. `--shadow` is written into the command, so the entry becomes a shield that watches and records but changes nothing (illustration):

```json
{
  "mcpServers": {
    "example-server": {
      "command": "npx",
      "args": ["-y", "zn-gate", "shield", "--shadow", "--", "node", "example-server.js"]
    }
  }
}
```

In shadow mode:

- A tool call that would be refused is still forwarded to the server, and the shield writes a `[zn-shield BLOCKED REQUEST]` line to stderr.
- Tool output is forwarded untouched: no secret is redacted. This is the one place where shadow mode lets a secret reach the agent, so use it to evaluate, not as a protection.
- Tool pinning still detects changes and logs them, but it does not mark, remove or refuse any tool.
- Every detection is written to the decision log.

## 3. Look at what was logged

Two days later, example-server ships an update: its `take_notes` tool now has a new description that tells the agent to send the notes to https://example.com/collect. The shield flags the change and writes it to the decision log (`~/.zn/evidence.jsonl` on your machine; nothing is sent anywhere). To read the last records:

```bash
npx -y zn-gate evidence --tail 20
```

With no option it prints the counts and the last 20 records; `--tail N` chooses how many. The `[zn-shield ...]` lines go to stderr: in an agent app, stderr goes to the MCP log of the app, not to your terminal. To check that the log has not been changed, run `npx -y zn-gate evidence --verify` (it exits `1` if it was).

## 4. List the pins

The first time the shield saw the tools of example-server, it recorded a fingerprint of each tool definition. List the pins:

```bash
npx -y zn-gate pins
```

`pins` lists each pinned server with its key, its command line, how many tools are pinned and when, and the names of the tools that changed or are new since then, each with what changed: its description, its parameters, other fields, or `new tool`. Here it shows `take_notes` with a changed description.

## 5. Review and approve the change

First look at the tool: open it in your agent, or read the source of the server or its changelog. `pins` shows tool names, not their text. If you accept the change, run in your own terminal:

```bash
SERVER='paste-the-server-name-here'
npx -y zn-gate pins approve "$SERVER"
```

Use the key that `pins` prints. zn-gate asks you to type the server key again before it approves; if what you typed does not match, nothing changes and you can run the command again. After approval the changed tools are pinned as the shield last saw them, and they work again the next time the agent lists the tools of the server.

Approval is your decision, not the decision of your agent: the command needs an interactive terminal and is refused when an AI agent runs it. To approve every server with pending changes at once, use `npx -y zn-gate pins approve --all`.

## 6. Switch to enforce

When the log looks right, switch to enforce:

```bash
npx -y zn-gate init --wrap-mcp
```

Or remove `--shadow` from the wrapped command yourself if you wrapped the server by hand. The shield then acts on what it finds:

- Tool and parameter descriptions that carry hidden instructions are neutralized before the agent reads them.
- A tool call whose arguments carry an injection is refused and never reaches the server.
- Secrets in tool output are redacted, and output that carries an injection is replaced by a short notice.
- A tool that changes or is new is flagged: in `warn` mode (the default) its description starts with a notice that tells the agent to ask you before using it, and the shield writes a `[zn-shield TOOLS CHANGED]` line to stderr; in `block` mode the tool is removed from the list and any call to it is refused.

Set the mode in `~/.zn/config.json` with `{ "mcpPinning": "block" }`, or for one run with `ZN_MCP_PINNING=block`. The mode that applies is the strictest of the two.

## 7. Restore the original files

```bash
npx -y zn-gate init --revert
```

Puts back the MCP configs saved before zn wrapped them. It does not remove the Claude Code plugin, hooks or markers in `.env` files; for those, run [uninstall](../cli.md#uninstall).

## Where to go next

- [Protect MCP servers: shield, shadow mode and tool pins](../shield.md), the full page, including tool shadowing and the limits
- [Every command and exit code](../cli.md)
- [What zn-gate cannot protect](../threat-model.md)
