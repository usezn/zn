# Example: explain a blocked `.env` read with `zn why`

A worked example of what to do when your agent could not read a `.env` file with its file-read tool: see the message the agent got, ask `zn-gate why` what the log says about it, and pick a safe way to go on. The [other walkthrough](why-blocked-walkthrough.md) follows a `cat .env` command; this page follows a read with the agent's own file tool, and shows what `why` can and cannot say about it. The output below comes from real runs on a test computer with a throwaway home folder and a made-up value. The hook event was fed by hand instead of by an agent, so no agent was needed. The times and the record id are only examples. For every option and exit code, see the [command line reference](../cli.md#why).

`zn-gate why` only reads your local decision log. It changes nothing and uses no network.

## The project

A small folder holds a `.env` file with a made-up value:

```text
EXAMPLE_API_KEY=example-not-a-real-key
PORT=3000
```

## What the agent tried

Before an agent runs a tool, its zn hook checks the call. This is the event for a read of the file (the path is made up and shortened):

```json
{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/path/to/project/.env"}}
```

The hook answers on its standard output, and the agent shows the reason to you:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). Ask the user to run `npx -y zn-gate@1.15.0 env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use."}}
```

The file was not read, so the value never reached the model. This is zn working, not an error. The message names the check that fired, here `secret-file:dotenv`, and the step to take.

## Ask `why`

In your own terminal, not through the agent:

```bash
zn-gate why
```

With no id it explains the last block in the log:

```text
zn blocked this at 2026-11-11T14:15:36.989Z (UTC).
  Record:  ev_mwc7bl7h_fdbfdb2d
  What:    a tool call, checked by the zn hook before it ran, tool "read" (agent: claude-code)
  Preview: {"event":"pre_tool","tool":"read","kinds":[]}   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)

Why it matters: zn stops an action that could expose secrets, damage the machine, change how zn runs, or leak data. The log does not keep which of these checks fired.

The log does not say which check it was, so no single command can be given. The message your agent received names it; see docs/troubleshooting.md, "Block and warn reasons, by family".
Who decides: Depends on the check: some actions only you may run in your own terminal, and some zn never lets an agent do.

Missing from the log: which check of the hook fired.
```

How to read it:

- `Record:` is the id of this block in the log. `zn-gate why <id>` explains a record you pick.
- `What:` says the tool was `read`, so the agent used its file tool, and which agent it was.
- `Preview:` is only the shape of the event: the event name, the tool, and an empty list of secret kinds. The log never keeps the path, the file text or a value. The empty list does not mean the file was harmless. The block is about the file name, not about text in the call.
- `Rule:` names the family, one of the checks of the hook. The log does not record which check fired, and `why` says so instead of guessing.
- There is no command to run, because the log does not say which check it was. The step comes from the message the agent received: `env shadow .env`. If the agent only told you "it was blocked", ask it for the exact text of the message.

The exit code is `0`. With no log yet it prints `zn why: there is no evidence log yet, so no block has been recorded on this computer.` and exits with `1`.

## Pick a safe way to go on

Run these in your own terminal, in the project folder. All three keep the value away from the agent.

### Move the values into the vault

```bash
zn-gate unlock
zn-gate env shadow .env
```

```text
Shadowed 1 value(s) in .env. The file now holds only markers; the values are in the local vault.
Encrypted copy of the original: ENVBAK_X86D8C749D202611111415 (restore with: zn env unshadow .env --backup ENVBAK_X86D8C749D202611111415)
Next: allow the commands that need them, e.g. zn secret allow EXAMPLE_API_KEY --command "npm run dev"
Run your app with the real values: zn run --secrets EXAMPLE_API_KEY -- <command>
```

The file keeps the other lines and now reads:

```text
EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__
PORT=3000
```

The same read by the agent is now allowed: the hook answers with nothing, and the agent gets the file with the marker in place of the value. The tool prints its own command as `zn`, the short name of `zn-gate`: both run the same program. The `ENVBAK_...` name in your output will differ. Keep it: it names the encrypted copy that `zn-gate env unshadow .env --backup <name>` puts back. See [the .env round trip](env-file-round-trip.md).

### Store one value and run with it

If you only need one value for one command, skip the file. Store it, then have the agent run the command through `zn run`:

```bash
zn-gate secret set EXAMPLE_API_KEY
zn-gate run --secrets EXAMPLE_API_KEY -- npm run dev
```

The first command asks for the value at a hidden prompt. The second gives the program the value as an environment variable on your computer, and the agent never sees it. The first run of a command with a secret has to be approved by you in the vault's own prompt. See [store a secret and run a program that uses it](secret-set-and-run.md).

### Give the agent a file with no values

A template such as `.env.example` that holds only names and empty values was not blocked in this test: the hook answered with nothing and the read went through. Ask your agent to read that, and to write the new variable names there.

## Explain an earlier block

When more blocks came after the one you want, export the log and take the `id` of that record:

```bash
zn-gate evidence --export
zn-gate why ev_mwc7bl7h_fdbfdb2d
```

An id that is not in the log gives exit code `1`.

## See also

- [Troubleshooting, section 6](../troubleshooting.md#6-your-agent-was-blocked-env-holds-plain-text-secrets): the message of this block.
- [Example: reading `zn why` after a blocked command](why-blocked-walkthrough.md)
- [Example: allow a blocked action after `zn why`](zn-why-allow-command.md)
- [Command line reference](../cli.md#why)
