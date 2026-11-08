# Example: what the exit code of a hook means to the agent

When your agent is about to run a command or read a file, it starts `zn hook <agent>` and waits. The hook answers in two ways at once: with what it prints, and with its exit code. This page shows both for the cases you will meet, from real runs, so you know why a block does not always come with a non-zero exit code. You do not run the hook yourself; this page only reads what it does. For the command itself, see [`hook`](../cli.md#hook) in the command reference.

The runs below used a throwaway home folder and a project with a fake `.env` file. The hints in the messages print `npx -y zn-gate@<version> ...` when `zn` is not on the PATH; this page shows `zn`. Each event was written on the standard input of `zn hook claude-code` (or `codex` or `cursor`, as named).

## 1. An allowed action

```json
{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls -la"}}
```

```text
exit: 0
stdout: (nothing)
stderr: (nothing)
```

Exit `0` and no output: the agent goes ahead.

## 2. A blocked action

The same kind of event, now a read of the fake `.env` file:

```text
exit: 0
stdout: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets. Ask the user to run `zn env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."}}
stderr: (nothing)
```

The exit code is `0`, and the block is in the answer: `permissionDecision` is `deny`, and the reason after `zn:` is what the agent is told. For an agent, a block that zn decided is a successful answer that says no. The same happened for `rm -rf ~`, and for a read of the `.env` file sent as a Codex event or a Cursor event; Cursor's answer uses its own shape, `{"permission":"deny","user_message":"..."}`, again with exit `0`.

## 3. A question instead of a block

Writing to a file that your agent reads as standing instructions, such as `AGENTS.md`:

```text
exit: 0
stdout: {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"zn: this writes to ~/project/AGENTS.md, which your agent reads as standing instructions in later sessions. Approve only if you asked for this change."}}
stderr: (nothing)
```

Exit `0` again. `ask` hands the decision to you: your agent asks you before it goes on. The path was shortened to `~/project`.

## 4. An event zn cannot read

If the event on standard input is empty or not valid JSON, zn cannot tell what the agent wanted, so it blocks. Here the input was `not json`:

```text
exit: 2
stdout: (nothing)
stderr: zn hook: zn: could not read this action (the event on stdin is not valid JSON), so it was blocked. If it happens again, ask the user to run `zn hooks install claude-code` to set up zn for Claude Code again.
```

Exit `2` is the code that several agents treat as a block, with stderr as the reason (zn's source says so for Claude Code, Codex, Gemini CLI and Copilot CLI, and that Claude Code and Codex show this stderr to the model). For an empty input the text says `stdin was empty`. For Cursor the run printed the same refusal and also a deny answer on standard output, `{"permission":"deny","continue":false,...}`, again with exit `2`; zn prints a deny answer as well for the agents that read their answer from standard output. The fix in both cases is the one in the message: run `zn hooks install <agent>` again in your own terminal.

## 5. An agent name zn does not know

```text
exit: 1
stderr: zn hook: unknown agent "nosuchagent" (supported: claude-code, codex, cursor, opencode, antigravity, copilot, gemini, zcode)
```

Exit `1` is a mistake in the settings that call the hook, not a decision about an action.

## Reading it as a table

| Exit code | Output | What the agent does | When it happens |
|---|---|---|---|
| `0` | none | Goes ahead. | The action is allowed. |
| `0` | `permissionDecision` `deny` (or the agent's own shape) | Does not run the action, and shows the reason. | zn decided to block. |
| `0` | `permissionDecision` `ask` | Asks you first. | zn wants your approval. |
| `2` | a refusal on stderr, for some agents also on stdout | Does not run the action. | zn could not read or check the event in time, so it blocks. |
| `1` | a message on stderr | The agent's own handling of a failed hook. | The agent name is unknown. |

What each agent does with a code other than `0` and `2` is the agent's own business, and it differs by agent. That is one reason the hook never leaves a failed check as a silent pass: for events it cannot check, it answers with a block.

## What to do with this

- To know whether zn blocked something, read the answer or run [`zn why`](zn-why-allow-command.md), not only the exit code. An exit code of `0` can still carry a block.
- A block with exit `2` and the words `could not read` means the setup needs repair: run `zn check --hooks` and then the fix it gives. See [Check that it works](../check.md#list-every-installed-hook).
- The exit codes of the other commands are in [Exit codes](../exit-codes.md). Its row for `hook` lists exit `2` as "blocked". In the runs on this page, exit `2` came only with the refusal for an event zn could not read, and every block that zn decided exited `0` with a deny answer; trust the runs here for the exact behavior.

## See also

- [`hook` in the command reference](../cli.md#hook)
- [Block message anatomy](block-message-anatomy.md): one block message taken apart.
- [Troubleshooting](../troubleshooting.md#block-and-warn-reasons-by-family): the reason texts by family.
