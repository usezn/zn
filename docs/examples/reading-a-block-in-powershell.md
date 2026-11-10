# Example: reading a block when your agent runs in Windows PowerShell

On Windows, some agents run their commands in PowerShell, and zn checks those commands the same way it checks a shell command on other systems. This page shows what the block message looks like for a PowerShell command, what changes in the commands it tells you to run, and how to run `zn why` from PowerShell to see the rule. All values are made up.

How the outputs were made: the messages below are real output of zn-gate, taken from the hook with a test event for the `PowerShell` tool, in a temporary home folder with a made-up `.env` file. That test ran on Linux, so it shows the text but not the Windows spelling of the commands inside it. Where the text differs on Windows, this page says so and points to the page that documents it.

## What your agent sees

Your agent runs this in its PowerShell tool:

```powershell
Get-Content .env
```

zn stops it before it runs. The agent is told:

```text
zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). Ask the user to run `npx -y zn-gate@1.15.0 env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use.
```

The shorter `type .env` and `cat .env` give the same message. The secrets did not reach the agent. This is zn working, not an error.

## What the message looks like on Windows

zn writes the commands in its messages for the shell you use. On Windows it uses the `.cmd` forms, because PowerShell can refuse to run the `.ps1` scripts that npm writes next to a program ([why](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows)). With no `zn` command on your PATH, the command in the message above reads:

```text
npx.cmd -y zn-gate@1.15.0 env shadow .env
```

and when `zn` is on your PATH it reads `zn.cmd env shadow .env`. The version number is the one of your zn-gate. The rest of the message is the same. Run the command in your own terminal, in the project folder, not through your agent.

## See the rule with `zn why`

[`zn why`](../cli.md#why) explains the last block in the local log, in plain words. It only reads the log. Run it in PowerShell, in your own terminal. Use the `.cmd` form, which works with the default execution policy:

```powershell
zn.cmd why
```

If you did not install zn-gate with `npm install -g zn-gate`, use `npx.cmd -y zn-gate why` instead. The output for the block above was:

```text
zn blocked this at 2026-11-10T16:37:33.751Z (UTC).
  Record:  ev_mwawya47_970b492c
  What:    a tool call, checked by the zn hook before it ran, tool "powershell" (agent: claude-code)
  Preview: {"event":"pre_tool","tool":"powershell","kinds":[]}   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)

Why it matters: zn stops an action that could expose secrets, damage the machine, change how zn runs, or leak data. The log does not keep which of these checks fired.

The log does not say which check it was, so no single command can be given. The message your agent received names it; see docs/troubleshooting.md, "Block and warn reasons, by family".
Who decides: Depends on the check: some actions only you may run in your own terminal, and some zn never lets an agent do.

Missing from the log: which check of the hook fired.
```

Read it like this:

- `What:` shows the tool the agent used, here `powershell`.
- `Rule:` names the check that fired. For a block by the zn hook, the log does not keep which check inside the hook it was, and `zn why` says so instead of guessing. The message your agent received names the rule: the part `(rule: secret-file:dotenv)` of the message above. Ask your agent to show you that message, or look it up in [troubleshooting](../troubleshooting.md#block-and-warn-reasons-by-family).
- The last lines say what to do. When a rule has one command you can run, `zn why` prints it, written with the `.cmd` forms on Windows.

To explain an older block, give the `id` of a record from `zn.cmd evidence --export`:

```powershell
zn.cmd why <id>
```

Exit codes: `0` explained, `1` nothing to explain, `2` wrong use. For example, an id that is not in the log gives:

```text
zn why: no record with the id "ev_nothing" in the evidence log.
```

with exit code `1`, and an unknown option gives `zn why: unknown option "--nope". usage: zn why [<id>] ...` with exit code `2`.

## Reading a file through a PowerShell variable

PowerShell writes the home folder as `$env:USERPROFILE`. zn reads such a variable like the folder it stands for. A command such as this one, run by the agent:

```powershell
Get-Content $env:USERPROFILE\.aws\credentials
```

is stopped like a read of the file by its full path. The agent is told:

```text
zn: $env:USERPROFILE\.aws\credentials was not read because zn treats it as holding secrets (AWS credentials file), and secret values never go to the model. If a command needs a value, ask the user to run `npx -y zn-gate@1.15.0 secret set NAME`, then run the command with `npx -y zn-gate@1.15.0 run --secrets NAME -- <command>` so the program gets it as an environment variable. Agents may not read the file itself (rule: secret-file:credential).
```

The `npx -y` commands read `npx.cmd -y` on Windows, as above. The message repeats the path as the agent wrote it.

## When a secret marker is in a PowerShell command

If the agent puts a marker such as `__ZN_NAME__` into a PowerShell command, zn cannot fill it in when the command is a cmdlet, a pipeline, a variable, a script block or a `.ps1` script. These are the messages, as documented in [troubleshooting](../troubleshooting.md#powershell-commands-that-carry-a-secret):

```text
zn: this PowerShell command uses a pipeline, a variable or a script block, so zn cannot safely put a secret into it.
zn: "<name>" is a PowerShell command, not a program, so zn cannot pass a secret to it.
zn: this runs a PowerShell script (.ps1), and zn cannot pass secrets into scripts.
zn: this command does not start with a plain program name, so zn cannot tell which program to run.
```

Each one is followed by the same next step. A real run with a `.ps1` script and a marker gave:

```text
zn: this runs a PowerShell script (.ps1), and zn cannot pass secrets into scripts. Next step: give the program the secret as an environment variable with `npx -y zn-gate@1.15.0 run --secrets NAME -- <command>` and have the program read it from there (for example psql reads PGPASSWORD). For web requests, use the secrets_http_request tool of the zn "secrets" MCP server instead.
```

Nothing is wrong. Ask the agent to start the command with the program itself and run it through `zn run --secrets NAME -- <command>` (`zn.cmd run ...` in PowerShell), as the message says.

## If a command fails in PowerShell

Two problems come from PowerShell and Windows, not from a block:

- `running scripts is disabled on this system`: use the `.cmd` forms (`zn.cmd`, `npx.cmd`), run the command in Command Prompt, or allow local scripts for your account once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. See [troubleshooting, section 3](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).
- `zn` is not recognized: the folder that `npm config get prefix` prints is not on your `PATH`. See [troubleshooting, section 14](../troubleshooting.md#14-zn-is-not-recognized-as-an-internal-or-external-command). Until then, use `npx.cmd -y zn-gate` in place of `zn`.

## Done

You can now read a block from your agent's PowerShell tool, run `zn.cmd why` to see which kind of check it was, and run the command the message gives in your own terminal. Pages to go on:

- [Example: reading `zn why` after a blocked command](why-blocked-walkthrough.md)
- [Windows checklist](windows-checklist.md)
- [`why` in the CLI reference](../cli.md#why)
