# Example: reading the JSON a hook returns on a block

When zn-gate stops an action of your agent, the agent does not read a message from you. It reads a small piece of JSON that the zn-gate hook printed. This page shows that JSON for a few agents and explains each field. It is for debugging, for example when you wonder why an agent behaved as it did after a block. Normally you never run the hook yourself: the agent starts it. All names and values below are made up.

For the plain-language text of a block message, see [Block message anatomy](block-message-anatomy.md). To see why something was blocked on your own machine, run [`zn why`](zn-why-allow-command.md).

## What the hook does

The agent runs `zn-gate hook <agent>` for every action it is about to take. It writes one event as JSON on standard input. The hook answers on standard output and with an exit code:

- **Allowed:** the hook prints nothing and exits `0`. For Claude Code it never prints a bare "allow", so your own permission rules still apply.
- **Blocked:** the hook prints a JSON decision and exits `0`. The JSON is what tells the agent to stop.
- **Could not decide:** if the event is not valid JSON, or something inside the hook fails, the hook blocks the action to be safe. It prints the reason on standard error, exits `2`, and for some agents also prints a deny JSON.
- **Unknown agent name:** the hook prints the supported names on standard error and exits `1`.

So a normal block is not exit code `2`. The decision is in the JSON, and exit code `2` is the signal for an event the hook could not read or check. (The [command reference](../cli.md#hook) summarizes this as "`2` blocked"; read it as the fail-closed case.)

## Try it with a made-up event

This sends one fictitious Claude Code event to the hook. The agent would be about to run a command that deletes the home folder. Nothing runs: the hook only reads the text of the event.

```bash
printf '%s' '{"session_id":"abc123","cwd":"/home/alice/project","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf ~"},"tool_use_id":"toolu_01"}' | zn-gate hook claude-code
echo "exit code: $?"
```

The hook prints this (one line, shown here on several lines):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "zn blocked this: it deletes the home folder, the filesystem root or a system folder, recursively. Ask the user to confirm before running this command. If they want it, they can run it in their own terminal; do not run it yourself."
  }
}
```

The exit code line shows `exit code: 0`.

## The fields, for Claude Code

| Field | Value here | What it means |
| --- | --- | --- |
| `hookSpecificOutput` | an object | The part of the answer that belongs to this one event. |
| `hookEventName` | `PreToolUse` | The moment the hook ran: before the agent uses a tool. |
| `permissionDecision` | `deny` | The decision. `deny` stops the action. `ask` makes the agent show you a question first. The hook does not print a bare `allow`. |
| `permissionDecisionReason` | a sentence | Text for the agent. It says what rule matched and what the agent should do next: ask you, and never try the action again by itself. It never contains the value of a secret. |

An `ask` answer has the same shape with `"permissionDecision": "ask"`: the action waits for your approval instead of being stopped.

### A blocked prompt looks different

When you type a prompt that holds a secret, the event is `UserPromptSubmit` and the answer has a top-level `decision`:

```json
{
  "decision": "block",
  "reason": "zn: this prompt was not sent because it contains a secret (an AWS key). Save it in your vault instead: ...",
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "suppressOriginalPrompt": true
  }
}
```

`decision: "block"` stops the prompt, `reason` explains it, and `suppressOriginalPrompt: true` keeps the text of your prompt out of the block message. The text can still be in the local prompt history on your machine. The example key in the test event was the well-known fake `AKIAIOSFODNN7EXAMPLE`.

## The same block for other agents

Each agent expects its own shape, so the hook adapts its answer. For the same `rm -rf ~` command, these are the answers of three more agents (the reason text is shortened here):

| Agent | What the hook prints | Decision field |
| --- | --- | --- |
| Codex CLI | Same shape as Claude Code: `hookSpecificOutput` with `permissionDecision` and `permissionDecisionReason` | `permissionDecision: "deny"` |
| Gemini CLI | `{"decision":"deny","reason":"zn blocked this: ..."}` | `decision: "deny"` |
| Cursor | `{"permission":"deny","user_message":"...","agent_message":"..."}` | `permission: "deny"`; `user_message` is for you and `agent_message` is for the agent |

All of them exit `0` on a block that the hook decided on its own.

## When the hook could not read the event

If you feed the hook text that is not JSON:

```bash
printf '%s' 'this is not json' | zn-gate hook claude-code
echo "exit code: $?"
```

it prints nothing on standard output, writes the reason on standard error, and exits `2`:

```text
zn hook: zn: could not read this action (the event on stdin is not valid JSON), so it was blocked. If it happens again, ask the user to run `npx -y zn-gate@<version> hooks install claude-code` to set up zn for Claude Code again.
```

The agents that treat exit code `2` as "block" (Claude Code, Cursor, Gemini CLI and ZCode) stop the action. An exit code other than `2` is a warning for several of them and the action would run, which is why the hook uses `2` and not `1` here.

## If you see a block you do not expect

1. Read the reason text: it names what matched (a file that holds secrets, a destructive command, a secret in a prompt).
2. Run [`zn why`](zn-why-allow-command.md) in your own terminal. It explains the last block from your local log and gives the one command that lets it through, when one exists.
3. For blocked shell commands, see [Destructive commands](../destructive-commands.md#how-to-read-a-blocked-command-message).
4. For the full list of exit codes, see [Exit codes](../exit-codes.md).
