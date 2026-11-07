# Example: reading `zn why` after a blocked command

A walk through one blocked command: what your agent sees, what `zn why` tells you in your own terminal, and the step that gets the work going. The outputs below come from a real run of zn-gate on a test machine with made-up values; the time, the record id and the form of the commands can be different on your machine. The families of block messages are collected in [troubleshooting](../troubleshooting.md).

## The blocked command

A small project folder holds a `.env` file with a made-up value:

```text
EXAMPLE_API_KEY=example-not-a-real-key
```

An agent set up with zn (here: Claude Code) runs:

```bash
cat .env
```

The zn hook checks the call before it runs and stops it. The agent is told:

```text
zn: .env holds plain-text secrets. Ask the user to run `npx -y zn-gate@1.15.0 env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use.
```

The secrets did not reach the agent: zn stopped the call before it ran. This is zn working, not an error.

## What you run: `zn why`

[`why`](../cli.md#why) explains, in plain words, the last block in the local evidence log. Run it in your own terminal, not through your agent. If you did not install zn-gate with `npm install -g zn-gate`, put `npx -y zn-gate` where the commands below say `zn`.

```bash
zn why
```

```text
zn blocked this at 2026-11-07T19:08:21.017Z (UTC).
  Record:  ev_mw6s0n15_382e5f20
  What:    a tool call, checked by the zn hook before it ran, tool "bash" (agent: claude-code)
  Preview: {"event":"pre_tool","tool":"bash","kinds":[]}   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)

Why it matters: zn stops an action that could expose secrets, damage the machine, change how zn runs, or leak data. The log does not keep which of these checks fired.

The log does not say which check it was, so no single command can be given. The message your agent received names it; see docs/troubleshooting.md, "Block and warn reasons, by family".
Who decides: Depends on the check: some actions only you may run in your own terminal, and some zn never lets an agent do.

Missing from the log: which check of the hook fired.
```

## Reading the output

- `zn blocked this at ... (UTC).` — zn stopped the call, and when.
- `Record:` the id of this block in the evidence log; `zn-gate evidence --export` writes every record out, and `zn why <id>` explains a record you pick instead of the last one.
- `What:` the kind of event, the tool and the agent that made the call.
- `Preview:` the short preview the log holds about the call, with secrets removed. Here it is only the shape of the event: the event name, the tool and the kinds of secret the command carried (an empty list here — the command text carried no value; the block is about the file it names). The log never stores a secret value, a path, a command or prompt text.
- `Rule:` which check fired: one of the checks of the zn hooks, before the agent ran the tool. The log does not keep which check inside the hook fired, and `zn why` says so instead of guessing.

The last lines say what to do: for a rule like this one there is no single command in the log, so `zn why` points at the message the agent received — and that message names the step.

## The allow step

Run the step in your own terminal, in the project folder:

```bash
zn env shadow .env
```

The values move to the vault and the file keeps markers such as `__ZN_API_KEY__` that the agent can use. To put the old file back, run the restore command that `zn env shadow` printed, for example `zn env unshadow .env --backup <name>`. More in [secrets](../secrets.md).

If you did not expect the read, ask your agent why it wanted that file, and do not look for a way around the block.

## More

- [Troubleshooting, section 6: "Your agent was blocked: `.env holds plain-text secrets`"](../troubleshooting.md#6-your-agent-was-blocked-env-holds-plain-text-secrets)
- [`why` in the CLI reference](../cli.md#why)
- [Example: reading a check output line by line](check-output-explained.md)
