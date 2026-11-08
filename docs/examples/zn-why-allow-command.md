# Examples: allow a blocked action after `zn why`

A worked example of what to do after zn-gate stops your agent: read the explanation from `zn why`, then run the one command it gives you, in your own terminal. All names, ids and values below are made up. For every option and exit code of `why`, see the [command line reference](../cli.md#why).

`zn why` only reads your local evidence log. It changes nothing and uses no network.

## When there is a command, and when there is not

`zn why` prints a command only when one exists. These are the cases:

| What was blocked | What `zn why` shows | Where to read more |
| --- | --- | --- |
| A secret value in a prompt, a command or a file | `secret set NAME` | [Example 1](#example-1-a-secret-value) |
| An MCP tool that is new or changed since you approved it | `pins approve <server>` | [Example 2](#example-2-a-changed-mcp-tool) |
| Text that gives the agent new orders (prompt injection) | No command: "No command lets this through." | [When there is no command](#when-there-is-no-command) |
| A check of the hooks, when the log does not say which one | No command; it points you to the block and warn reasons | [When there is no command](#when-there-is-no-command) |

## Example 1: a secret value

Your agent tried to run a command that held a key, and zn-gate stopped it. In your own terminal, run:

```bash
zn why
```

With no id, it explains the last block in the log. The output looks like this:

```text
zn blocked this at 2026-11-06T10:15:00.000Z (UTC).
  Record:  ev_example_0001
  What:    a tool call, checked by the zn hook before it ran, tool "Bash" (agent: claude-code)
  Preview: curl -H "Authorization: Bearer ..."   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-secret - A secret value in what zn checked before the agent ran a tool

Why it matters: A secret that reaches the model can end up in logs, in files or in someone else's hands. Secret values never go to the model.

To go on, run this in your own terminal (not through your agent):
  zn secret set NAME
Save the value there (NAME is a name you choose), then have the agent write __ZN_NAME__ where the value goes. The real value stays on your computer.
```

The preview is only what the log already holds, with secrets removed.

Run the command from the output. `NAME` is a name you choose, for example `EXAMPLE_API_KEY`:

```bash
zn secret set EXAMPLE_API_KEY
```

zn-gate asks for the value at a hidden prompt; a value is never accepted as an argument. Then tell your agent to write `__ZN_EXAMPLE_API_KEY__` where the key goes. The agent only ever sees the marker, and zn-gate fills in the real value where you allowed it. See [Keep secrets out of your coding agent](../secrets.md) for the full walkthrough, including `--host` and `--command` to limit where a value may be used.

`secret set` needs an interactive terminal and refuses to run inside an agent. That is why `zn why` says "in your own terminal (not through your agent)".

## Example 2: a changed MCP tool

An MCP server that you approved earlier changed one of its tools, so zn-gate stopped the call. Run:

```bash
zn why
```

```text
zn blocked this at 2026-11-06T11:40:00.000Z (UTC).
  Record:  ev_example_0002
  What:    the tools of an MCP server, checked by zn-shield against what you approved, tool "my-server@1" (agent: mcp-server)
  Preview: list_files   (as stored in the log, with secrets already removed)
  Rule:    mcp_tool_changed - An MCP tool is new or different since you approved it

Why it matters: A server you trusted can change what its tools say, or add tools, after you approved them. That is a way a good server turns bad, so zn asks you first.

To go on, run this in your own terminal (not through your agent):
  zn pins approve my-server@1
Read the changed tools first (`zn pins` lists them). This works only in your own terminal and asks you to type the confirmation. It cannot approve a server that lists the same tool twice or tools without a valid name: the server has to fix that.
```

Do what the note says: read the changes first, and only then approve.

```bash
zn pins
zn pins approve my-server@1
```

`pins approve` asks you to type the server key again to confirm. If the name from the log is not a plain name, `zn why` prints `<server>` in its place; take the real name from `zn pins`.

## Explain an older block by its id

`zn why` with no id explains the last block. To explain an earlier record, export the log and find its `id`:

```bash
zn evidence --export
zn why ev_example_0001
```

An id that is not in the log gives exit code `1`.

## When there is no command

For some rules no command lets the action through. For text that tries to give the agent new orders, `zn why` says so and who decides:

```text
  Rule:    pi:ignore_previous - Text that tells the agent to ignore or replace its earlier instructions

Why it matters: Text like this is how a web page, a file or a tool can give orders to your agent behind your back. If the agent obeyed it, it could act for whoever wrote the text instead of for you.

No command lets this through.
Who decides: You decide whether to keep using the source of the text.
```

There is nothing to approve here. The block did its job; decide whether you still trust the source of the text.

When a hook block does not record which check fired, `zn why` says `Missing from the log: which check of the hook fired.` and gives no command. The message your agent received names the check; see [Block and warn reasons, by family](../troubleshooting.md).

## Exit codes of `zn why`

| Code | Meaning |
| --- | --- |
| `0` | A record was explained. |
| `1` | Nothing to explain: no log yet, no block in it, an id that is not in it, or a log that cannot be read. |
| `2` | Wrong usage, for example an unknown option or more than one id. |
