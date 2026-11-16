# Examples: reading a wrapped block message in CI logs

A worked example of finding why zn-gate stopped a coding agent in a CI job, when all you have is the job log. A log line that is long gets wrapped over several lines, and each line gets its own timestamp, so the message you want is cut in pieces. All names, times and values below are made up. The block messages are the real texts that the zn hook produced for two test commands; nothing was run, the hook only read the text of each command.

Back to the [examples index](README.md).

This page is about a job where the agent runs with zn's hooks active. The zn-gate Action does not install hooks for the agent that your workflow starts: see [What zn-gate does not protect in CI](../agents-in-ci.md#what-zn-gate-does-not-protect-in-ci).

## The log

The job log below is made up. The agent tried two commands and was stopped twice. The log wraps each long line at about 72 characters and puts a timestamp in front of every line:

```text
2026-11-11T09:14:00.0000000Z Run npm test
2026-11-11T09:14:00.0000000Z agent: running tool Bash
2026-11-11T09:14:00.0000000Z zn blocked this: it deletes the home folder, the filesystem root or a
2026-11-11T09:14:00.0000000Z system folder, recursively (rule: destructive:rm_root_home). Ask the
2026-11-11T09:14:00.0000000Z user to confirm before running this command. If they want it, they can
2026-11-11T09:14:00.0000000Z run it in their own terminal; do not run it yourself.
2026-11-11T09:14:00.0000000Z agent: the command was refused, trying another way
2026-11-11T09:14:00.0000000Z agent: running tool Bash
2026-11-11T09:14:00.0000000Z zn: .env holds plain-text secrets, and secret values never go to the
2026-11-11T09:14:00.0000000Z model (rule: secret-file:dotenv). Ask the user to run `zn env shadow
2026-11-11T09:14:00.0000000Z .env` in their terminal: it moves the values to the local vault and
2026-11-11T09:14:00.0000000Z leaves __ZN_<NAME>__ markers you can read and use.
2026-11-11T09:14:00.0000000Z Run completed
```

## What to search for

Every message from the zn hook starts with `zn:` or with `zn blocked this:`. Search for both:

```bash
grep -n -E 'zn( blocked this)?:' ci.log
```

```text
3:2026-11-11T09:14:00.0000000Z zn blocked this: it deletes the home folder, the filesystem root or a
9:2026-11-11T09:14:00.0000000Z zn: .env holds plain-text secrets, and secret values never go to the
```

Each hit is the first line of a message. Show the lines after it to read the rest, up to the line where the agent speaks again:

```bash
grep -n -A4 'zn blocked this' ci.log
```

```text
3:2026-11-11T09:14:00.0000000Z zn blocked this: it deletes the home folder, the filesystem root or a
4-2026-11-11T09:14:00.0000000Z system folder, recursively (rule: destructive:rm_root_home). Ask the
5-2026-11-11T09:14:00.0000000Z user to confirm before running this command. If they want it, they can
6-2026-11-11T09:14:00.0000000Z run it in their own terminal; do not run it yourself.
7-2026-11-11T09:14:00.0000000Z agent: the command was refused, trying another way
```

## Find the rule name

The part you want is the rule in brackets: `(rule: destructive:rm_root_home)`. A search for `rule:` finds the lines that hold it:

```bash
grep -n 'rule: ' ci.log
```

```text
4:2026-11-11T09:14:00.0000000Z system folder, recursively (rule: destructive:rm_root_home). Ask the
10:2026-11-11T09:14:00.0000000Z model (rule: secret-file:dotenv). Ask the user to run `zn env shadow
```

This works while the wrap does not fall inside the brackets. A wrap can cut `(rule:` from its name. A way that does not depend on where the log was cut is to remove the timestamps, join the lines and then cut out every rule:

```bash
sed 's/^[^ ]* //' ci.log | tr '\n' ' ' | grep -o '(rule: [^)]*)'
```

```text
(rule: destructive:rm_root_home)
(rule: secret-file:dotenv)
```

Look the rule name up on the [troubleshooting page](../troubleshooting.md#block-and-warn-reasons-by-family), which lists the blocks by family, or in [destructive commands](../destructive-commands.md) for a `destructive:` rule. The step for a person is in the message itself, for example `zn env shadow .env`. Run it in your own terminal, not in the job.

## Why `zn why` says less than the log

The message in the log names the rule. The record in the evidence log, which `zn why` reads, keeps only the group of checks. If you have the evidence log of the job (see the next section), `zn why` shows this for the last block (the time and the id come from a separate test run, so they do not match the log above):

```text
zn blocked this at 2026-11-11T11:50:30.613Z (UTC).
  Record:  ev_mwc24zbp_d25c46ae
  What:    a tool call, checked by the zn hook before it ran, tool "bash" (agent: claude-code)
  Preview: {"event":"pre_tool","tool":"bash","kinds":[]}   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)
```

The rest of the output says that the log does not keep which check fired, and points to the message the agent received. So for a block of the hook, the job log is where the specific reason is. Keep it.

## Read the evidence log of a job

`zn why` reads the evidence log of the machine where it runs, so it has nothing to show for a block that happened on a runner that is gone. If you want to look a block up afterwards, set [`ZN_HOME`](../cli.md#all-environment-variables) for the job to a folder in the workspace. It is the folder for zn's own files, and `evidence.jsonl` is one of them. Keep that one file as a job artifact. Then, on your own computer, put the downloaded file in a folder named `zn-evidence` in your current folder:

```bash
ZN_HOME=./zn-evidence zn why
ZN_HOME=./zn-evidence zn evidence --verify
```

```text
[ok] Cryptographic Evidence Ledger Verification:
  Ledger Path   : <path>/zn-evidence/evidence.jsonl
  Total Records : 1
  Integrity     : [ok] ALL SHA-256 HASHES VERIFIED (IMMUTABLE)
```

Without `ZN_HOME`, the same `zn why` on your computer reads your own log and says: `zn why: there is no evidence log yet, so no block has been recorded on this computer.` It exits with code `1`.

A record holds a short preview with secrets removed, never a secret value; see [Block message anatomy](block-message-anatomy.md) for the fields. Do not upload the rest of the `ZN_HOME` folder: it can hold other files of zn that you do not need for this. Try the setting in a test job first, because it moves all of zn's own files for that job.

`zn test` does not replay a block. It runs zn-gate's own built-in examples, so it cannot reproduce the block of your job; use the message and its rule name instead.

## See also

- [Why was this blocked?](../why-was-this-blocked.md): five common messages and how to go on safely.
- [Examples: allow a blocked action after `zn why`](zn-why-allow-command.md)
- [Coding agents in CI](../agents-in-ci.md)
