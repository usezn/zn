# zn-gate for beginners

You have never used a terminal agent, or you have just started. This page explains in plain words what zn-gate does and what it never does. It repeats only what the [architecture page](architecture.md) and the [glossary](glossary.md) already say, so use those for the full detail.

## Before you begin

- [ ] [Node.js](first-5-minutes.md#before-you-start) installed (run `node --version` to check)
- [ ] [A terminal](first-5-minutes.md#before-you-start) open, separate from your agent
- [ ] [A supported agent](first-5-minutes.md#1-install) on your machine

## Some words first

- A **coding agent** (Claude Code, Codex CLI, Cursor or OpenCode) is a program that reads your files and runs commands for you.
- The **terminal** is the window where you type commands. Run zn-gate's setup commands in your own terminal, not through an agent.
- A **secret** is a value that gives access to something, such as an API key, a token or a password.

## What zn-gate is

zn-gate is a small checkpoint on your own machine. It sits between your agent and everything the agent does not control: your prompts, the files it reads, web pages, and the tools and MCP servers it calls. It runs locally, needs no account, and sends nothing off your machine by default.

## What it does

zn-gate checks three moments of a tool call:

| Moment | What zn-gate looks for |
|---|---|
| Before the agent acts on a prompt | Prompt injection (text that tries to make an agent ignore your instructions), jailbreaks, and requests to read files or send data out |
| Before a tool runs | Injection wording, requests for secrets, secret-file names, and secrets in the arguments (which it masks) |
| After a tool runs, before the model sees the output | Injection hidden in the output, and secrets and personal data (which it redacts) |

It also does these things on your machine:

- **Hides secrets.** The agent sees a stand-in called a marker, such as `__ZN_AWS_KEY_1__`. The real value stays in an encrypted **vault** on your machine. `zn run` fills in the value only for a command you approved.
- **Redacts.** When it recognises a secret or personal data in text, the model sees a marker or `[REDACTED_...]` instead of the value.
- **Blocks some reads.** With hooks installed, it blocks reads of secret files and pasted secrets. A **hook** is a small check your agent runs before or after it reads a file, runs a command or gets your prompt.
- **Keeps a record.** Each assessment goes to a local decision log, `~/.zn/evidence.jsonl`.

## What it never does

- It does not send your prompts, files, tool arguments or tool output off your machine by default. Tool arguments, tool output and tool descriptions never leave the machine, even with the optional cloud check on.
- It does not need an account or an API key for the local checks.
- It is not a sandbox. It checks what an agent's hooks can see, and it does not stop a program from touching other things.
- It does not judge whether a shell command or a query is destructive in the tool-call check. That check is text-based.
- It does not protect everywhere equally. It works where the agent gives it enough information, and [Agent compatibility](compat.md) shows what each agent allows.
- Its decision log is not tamper-proof. The hash chain detects accidental or partial edits, but someone who can write to the file can recompute it.

## The one optional online part

The cloud check is off until you turn it on. It needs both `ZN_CLOUD=1` and `ZN_API_KEY`, or a run of `zn-gate connect`. It only looks at prompts, and the text has recognised secrets removed before it is sent. If the call fails, the local result stands and nothing is blocked because of it. See [Connect](connect.md).

## Your first run: a fake secret gets flagged

You can see zn-gate catch a secret without risking anything. The steps below use a made-up key. Run them in your own terminal, not through your agent.

1. Make an empty folder and go into it:

   ```bash
   mkdir zn-first-run
   cd zn-first-run
   ```

2. Create a file named `.env` (the dot is part of the name) with this one line:

   ```text
   AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
   ```

   `AKIAIOSFODNN7EXAMPLE` is the example key that Amazon publishes in its own documentation. It does not open anything. In a text editor, choose "All files" when you save, so the file is not called `.env.txt`.

3. Run the scan:

   ```bash
   npx -y zn-gate scan .
   ```

The output is what zn-gate printed on a real machine, with one change: the `Target` line shows a placeholder folder instead of the full path of that machine.

```text
[+]  zn-gate Static Security Audit
Target  : /home/you/zn-first-run
Scope   : Prompt templates, docs, configs (use --code to scan source)
Files   : 1 file(s) queued for audit

Findings (1):
  [x] .env:1 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]
    Next: run npx -y zn-gate env shadow .env to move the values into the local vault, and rotate any value that was ever committed or shared.


-----------------------------------------------------------------------------
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 1
Files Skipped: 0
Status       : Move the secrets out of these files (see "Next" for each one)
-----------------------------------------------------------------------------
```

### What each part means

- **`zn-gate Static Security Audit`**: the name of the check. It only reads files. It does not run anything from them.
- **`Target`**: the folder it checked. **`Scope`**: the kinds of files it reads by default, here text, docs and config files. `.env` is a config file, so it is read.
- **`Files : 1 file(s)`**: the one file in the folder, `.env`.
- **`[x] .env:1 Secret found`**: the file and the line number where it found a secret. The `[x]` marks a finding.
- **`Rule: secret:aws_access_key`**: the kind of secret the rule recognises, here an AWS access key.
- **`Line: AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]`**: the line as zn-gate saw it, with the value replaced by `[REDACTED_AWS_KEY]`. zn-gate never prints the value itself, so you can paste this report without leaking it.
- **`Next:`**: what to do. For a real key, move the value into zn's encrypted vault with the command shown (see [Keep secrets out of your agent](secrets.md)), and replace the key with a new one if the old one was ever shared or committed. This key is fake, so there is nothing to replace.
- **`Audit Result : FAILED`**: at least one secret was found. The scan stops with exit code `1`, which a script or a CI job reads as "stop and look" (see [exit codes](exit-codes.md)).

The scan only reports. It does not stop your agent. The part that stops an agent from reading a `.env` file is the hook that zn-gate installs for it. [Check that it works](check.md) tests exactly that, and [What the check output means](examples/check-output-explained.md) explains each line of that output.

When you are done, go back up and delete the test folder (`cd ..` and then `rm -r zn-first-run`, or `Remove-Item -Recurse zn-first-run` in PowerShell).

If you installed zn-gate with `pip` instead of `npx`, run `zn-gate scan .` in place of the command above. The wording of the report can differ a little between the Node.js and the Python versions.

## If you see this message

These are three messages a new user often meets first. Each one is explained in [Troubleshooting](troubleshooting.md).

- **"zn-gate needs Node.js 18 or later, and this is Node.js v..."**: install the LTS version from [nodejs.org](https://nodejs.org/), open a new terminal, check `node --version`, then run your command again. ([Details](troubleshooting.md#1-nodejs-is-too-old))
- **"... needs an interactive terminal. Open a terminal window yourself and run it there."**: open a terminal window yourself, not the agent's window, and run the same command there. Nothing was changed. ([Details](troubleshooting.md#4-it-needs-you-at-your-own-terminal))
- **"Your secret vault is locked."**: run `zn unlock` in your own terminal, then run the command that failed again. ([Details](troubleshooting.md#5-your-secret-vault-is-locked))

## Where to go next

1. [First 5 minutes](first-5-minutes.md): install zn-gate and see it work.
2. [Check that it works](check.md): confirm your agent is protected.
3. [Keep secrets out of your agent](secrets.md): the vault and markers in practice.
4. [Architecture](architecture.md) and [threat model](threat-model.md): the full picture.
