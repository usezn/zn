# The zn hook command, explained

When zn-gate stops your agent, the message starts with `zn:` and you never typed a zn command for it. The command behind the message is `zn-gate hook <agent>`, which [the command list](../cli.md#hook) calls the entry point the agents call. This page says what it is, who calls it, and why you rarely run it by hand. All values in the examples are made up.

## What it does

The command reads one event as JSON on standard input and answers on standard output. The event describes one moment of the agent session, and the answer tells the agent to go on or to stop, with a reason.

The moments and the checks, from the [agent compatibility table](../compat.md):

- Before a tool runs: blocks reads of `.env` files with values, of credential files and of `~/.zn`, and checks MCP tool calls before they run.
- After a tool ran: scrubs secret values out of the tool output before the model sees it (where the agent lets a hook rewrite the output).
- When you send a prompt: blocks the prompt when it contains a pasted secret.

## Who calls it

You do not add `zn-gate hook` to any settings file by hand. [`zn hooks install <agent>`](../cli.md#hooks) writes the settings that make the agent call the hook, and `zn hooks uninstall <agent>` removes them again. The settings go through a small launcher script under `~/.zn/hooks`, shared by every profile of the same agent on the machine (see [the glossary](../glossary.md)).

Eight agents take the hooks: claude-code, codex, cursor, opencode, antigravity, copilot, gemini (experimental) and zcode. The table in [by-agent](../by-agent.md) lists the install, verify and remove commands for each, and for Claude Code also the plugin that sets the hooks up in one step.

The command itself checks the name, and refuses one it does not know with exit code 1:

```text
zn hook: unknown agent "nosuchagent" (supported: claude-code, codex, cursor, opencode, antigravity, copilot, gemini, zcode)
```

## What one call looks like

A project holds a fake `.env` file, and the agent tries to read it. The agent writes one event as JSON on the standard input of the hook (shortened here; the path is made up):

```json
{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/home/you/project/.env"}}
```

The hook answers on standard output. This is the answer from a real run:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets. Ask the user to run `npx -y zn-gate@1.15.0 env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."}}
```

The deny travels in the JSON answer (`permissionDecision: deny`), and the reason after `zn:` is the message the agent shows you. [block-message-anatomy.md](block-message-anatomy.md) explains one such message part by part. An event that is allowed gets an empty answer. The exit codes of the command are in [the command list](../cli.md#hook).

## Why you rarely run it by hand

- The agent already runs the hook at every read, command and prompt. On standard input it expects one event as JSON; by hand there is nothing to feed it that the agent would not send anyway.
- The commands that help you run in your own terminal:
  - `npx -y zn-gate check` asks the hook to read a fake `.env` in a temporary folder and reports whether it was blocked (see [Check that it works](../check.md)).
  - `zn-gate check --hooks` lists every installed hook and says whether each is OK, stale or broken, with the command that fixes it ([what the output means](../check.md#list-every-installed-hook)).
  - `zn-gate why` explains one block from the local decision log in plain words (worked example: [zn-why-allow-command.md](zn-why-allow-command.md)), and `zn-gate evidence` shows the log.
  - `zn hooks install <agent>` again repairs the settings after an upgrade or when the Node.js the hook used is gone.
- One table of common questions and the command that answers each is in [which-command-shows-what.md](which-command-shows-what.md).
