# Example: `pins approve` with a server key that does not exist

`zn-gate pins approve` takes the key of one pinned MCP server, as printed by `zn-gate pins`. This page shows what happens when the key you type is wrong, which message you get in which situation, and how to find the right key. All values on this page are made up, and the messages were captured from a real run in a throwaway home folder (zn-gate 1.15.0) with one fake pinned server called `example-mcp-server --demo`.

Approving is your decision, not your agent's: run these commands in your own terminal. For background on what a pin is and what to check before approving, see [Protect MCP servers: shield, shadow mode and tool pins](../shield.md) and the [pin review checklist](mcp-pin-review-checklist.md).

## 1. Look up the key first

```bash
npx -y zn-gate pins
```

```text
MCP tool pins (~/.zn/mcp-pins, mode: warn)

  371efe2c6eeca9aa  example-mcp-server --demo
      1 tool(s) pinned 2026-11-10T18:31:46.085Z
```

The 16-character key at the start of the line is what `pins approve` expects. It identifies a server by its command line, so a copy that is cut short or has a typo is a different key. The list exits with code `0`. With nothing pinned yet it says `No MCP server has been pinned yet.` and also exits with `0`.

## 2. The wrong key, typed in your own terminal

Say you type a key that is not in the list:

```bash
npx -y zn-gate pins approve 0123456789abcdef
```

Before it looks at the key, zn-gate asks you to type it again. Typing the same wrong key again gives:

```text
Type the server key again to approve: 0123456789abcdef
zn-gate pins: no server 0123456789abcdef. Run `zn-gate pins` to see the servers and their full keys.
```

The exit code is `2` and nothing changes. A prefix of a real key fails the same way: with `371efe2c` in place of the full key the message is `no server 371efe2c`. Copy the whole key from `zn-gate pins` and run the command again.

Two other things can happen at that prompt, both with exit code `2` and nothing changed:

- You type something different the second time, or end the input: `Not approved: what you typed did not match, so nothing was changed. Run the command again to retry.`
- If your vault is unlocked, it may ask you to confirm the approval before the key is looked up. The wrong key then fails after that confirmation, with the same `no server` message.

If the key is right but the server has no changed or new tools, the command prints `Nothing to approve.` and exits with `0`. With `--all` the prompt asks for the word `all` instead of a key.

## 3. Which message you get first

The checks run in a fixed order, and the first one that fails ends the command. For `pins approve <key>` the order is:

1. No key given: `usage: zn-gate pins approve <server>|--all` (exit `2`).
2. An AI agent is running the command: `zn-gate pins approve must be run by you in your own terminal, not by an AI agent (detected CLAUDECODE).` (exit `2`). zn-gate looks for the variables agents set and for an agent program among the parent processes. With an agent, you get this message even in a real terminal.
3. No terminal (input or output is a pipe or a script): `zn-gate pins approve runs only in your own terminal, so that an agent cannot approve tool changes. Run it there.` (exit `2`).
4. Only then does the prompt appear, and only after it is answered does zn-gate check that the key exists.

So an unknown key is never reported from a script or from an agent: the refusal about the terminal or the agent comes first, and it does not tell you whether the key is right. Check the key with `zn-gate pins`, which any of them can run.

## Done

You can now:

- find the right key with `zn-gate pins` before you approve,
- tell a wrong key (`no server ...`) from a refusal about who runs the command (agent first, then no terminal),
- read the exit code: `2` for every refusal, `0` for `Nothing to approve.`

## Next steps

- [Checklist: reviewing an MCP pin change before you approve it](mcp-pin-review-checklist.md)
- [`pins` in the CLI reference](../cli.md#pins)
- [Protect MCP servers: shield, shadow mode and tool pins](../shield.md)
