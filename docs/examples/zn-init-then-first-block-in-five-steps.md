# Example: from `init` to your first block, in five steps

A compact path to copy and paste: set zn-gate up, check it, make it block one command, read the block and ask it why. You do not run any dangerous command: step 3 gives the hook the text of a command as an event, and nothing is executed. All values are made up.

Run every command in your own terminal, not through your agent. You need Node.js and at least one supported coding agent installed first (see [First 5 minutes](../first-5-minutes.md#before-you-start)).

## 1. Set up

```bash
npx -y zn-gate init
```

`init` finds your coding agents and asks before each step. Say yes to the step for your agent. If an AI agent or a script runs it, or there is no terminal, it only prints the steps and changes nothing.

## 2. Check that it works

```bash
npx -y zn-gate check
```

It makes a temporary folder with a fake key in a `.env` file, asks the hook of each agent whether it may read it, and deletes the folder. When your agent is set up, its line starts with `OK`:

```text
  OK Claude Code  blocked the .env file and allowed the ordinary file. Your agent would be told:
```

A line that starts with `-` means zn is not set up for that agent, or the agent is not on this machine. Then run step 1 again. [What the output means](../check.md).

## 3. Make it block one command

Send the hook one event that carries the text of a command that writes to a disk device. The command is only text here: it is read, never run.

```bash
printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"dd if=/dev/zero of=/dev/sda"}}' | npx -y zn-gate hook claude-code
```

## 4. Read the block

The hook answers on standard output. This is the answer from a real run:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn blocked this: it writes to or formats a disk device (rule: destructive:disk_overwrite). Ask the user to confirm before running this command. If they want it, they can run it in their own terminal; do not run it yourself."}}
```

`deny` is the block. The words after `rule:` name the check that fired, and the rest says what to do next. This is what your agent is told when it tries the same command. An allowed command gets no answer at all. [The message, part by part](block-message-anatomy.md).

## 5. Ask why

```bash
npx -y zn-gate why
```

`why` explains the last block in the local decision log. It only reads the log. This is the output of a real run (the time and the record id are different on your machine):

```text
zn blocked this at 2026-11-11T09:48:23.233Z (UTC).
  Record:  ev_mwbxrxhd_69e48c11
  What:    a tool call, checked by the zn hook before it ran, tool "bash" (agent: claude-code)
  Preview: {"event":"pre_tool","tool":"bash","kinds":[]}   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)

Why it matters: zn stops an action that could expose secrets, damage the machine, change how zn runs, or leak data. The log does not keep which of these checks fired.

The log does not say which check it was, so no single command can be given. The message your agent received names it; see docs/troubleshooting.md, "Block and warn reasons, by family".
Who decides: Depends on the check: some actions only you may run in your own terminal, and some zn never lets an agent do.

Missing from the log: which check of the hook fired.
```

The log does not keep the name of the check inside the hook, so the rule name is only in the message of step 4. The log never stores the command text.

Step 3 added one record to your decision log in your `~/.zn` folder. It does not change any setting.

## More

- [Example: reading `zn why` after a blocked command](why-blocked-walkthrough.md)
- [First 5 minutes with zn-gate](../first-5-minutes.md)
- [Destructive commands](../destructive-commands.md): the rules behind the block in step 4.
- [`hook`](../cli.md#hook), [`check`](../cli.md#check) and [`why`](../cli.md#why) in the command reference.
