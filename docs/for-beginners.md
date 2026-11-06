# zn-gate for beginners

You have never used a terminal agent, or you have just started. This page explains in plain words what zn-gate does and what it never does. It repeats only what the [architecture page](architecture.md) and the [glossary](glossary.md) already say, so use those for the full detail.

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
- **Keeps a record.** Each assessment goes to a local audit log, `~/.zn/evidence.jsonl`.

## What it never does

- It does not send your prompts, files, tool arguments or tool output off your machine by default. Tool arguments, tool output and tool descriptions never leave the machine, even with the optional cloud check on.
- It does not need an account or an API key for the local checks.
- It is not a sandbox. It checks what an agent's hooks can see, and it does not stop a program from touching other things.
- It does not judge whether a shell command or a query is destructive in the tool-call check. That check is text-based.
- It does not protect everywhere equally. It works where the agent gives it enough information, and [Agent compatibility](compat.md) shows what each agent allows.
- Its audit log is not tamper-proof. The hash chain detects accidental or partial edits, but someone who can write to the file can recompute it.

## The one optional online part

The cloud check is off until you turn it on. It needs both `ZN_CLOUD=1` and `ZN_API_KEY`, or a run of `zn-gate connect`. It only looks at prompts, and the text has recognised secrets removed before it is sent. If the call fails, the local result stands and nothing is blocked because of it. See [Connect](connect.md).

## Where to go next

1. [First 5 minutes](first-5-minutes.md): install zn-gate and see it work.
2. [Check that it works](check.md): confirm your agent is protected.
3. [Keep secrets out of your agent](secrets.md): the vault and markers in practice.
4. [Architecture](architecture.md) and [threat model](threat-model.md): the full picture.
