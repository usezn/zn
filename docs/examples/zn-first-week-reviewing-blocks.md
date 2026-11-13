# Examples: your first week of reviewing blocks

A small routine for the first week with zn-gate: five minutes a day, three commands, all run in your own terminal. It helps you see what zn stopped, check that each block was one you wanted, and notice when the same thing keeps happening. All values below are made up. The outputs come from real runs of zn-gate in a throwaway home folder, with five test events (four of them blocked) from one day, so a real week will show more days and different numbers.

Back to the [examples index](README.md).

If you installed zn-gate with `npx`, put `npx -y zn-gate` where the commands below say `zn`.

## The test events

The test folder had a `.env` file with a made-up value. Five events went through the Claude Code hook: the command `cat .env`, a read of a file named `.ssh/id_rsa` in the home folder, the command `rm -rf /usr`, the command `ls -la`, and a prompt with a made-up AWS key. The hook only read the text of each one; nothing was run. Four of them were blocked and the fifth, `ls -la`, was allowed.

## Each day: three commands

### 1. What was the last block? `zn why`

```bash
zn why
```

```text
zn blocked this at 2026-11-11T11:50:31.239Z (UTC).
  Record:  ev_mwc24zt3_b954f7b4
  What:    a prompt you typed, checked by the zn hook before it went to the model, tool "user_prompt" (agent: claude-code)
  Preview: {"event":"user_prompt","tool":null,"kinds":["AWS_KEY"]}   (as stored in the log, with secrets already removed)
  Rule:    hook-user_prompt-secret - A secret value in what zn checked on a prompt you typed

Why it matters: A secret that reaches the model can end up in logs, in files or in someone else's hands. Secret values never go to the model.

To go on, run this in your own terminal (not through your agent):
  zn secret set NAME
Save the value there (NAME is a name you choose), then have the agent write __ZN_NAME__ where the value goes. The real value stays on your computer.
```

Ask yourself one thing: did I expect this? A prompt with a key in it is what zn is for. If it was a slip, the block did its job, and the output says what to do next. If you did not paste a key and zn says you did, note it; it is worth a look at the next step. See [Examples: allow a blocked action after `zn why`](zn-why-allow-command.md) for the commands `why` can give you.

### 2. How many, and of what? `zn stats` and `zn report`

```bash
zn stats
```

```text
zn-gate on this machine, last 30 days (counting since 2026-11-11):

  5 events checked (prompts, tool calls and tool results)
  4 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  0 secret values replaced before the model saw them

  Secret types found: AWS_KEY 1

  Top rules, last 7 days:
    AWS_KEY  Built-in detector  1
  Most frequent: AWS_KEY. To understand your last block, run: zn why

  By agent:
    claude-code (agent hooks): 5 events, 4 blocked, 0 replaced

  These counts stay on this machine. To help improve zn-gate, you can share pseudonymous daily counts:
  `zn-gate stats share show` shows exactly what would be sent, `zn-gate stats share on` turns it on.
```

For one day, `report` gives a shorter view, per agent:

```bash
zn report --since 1d
```

```text
zn-gate report: 2026-11-11 to 2026-11-11 (this computer only; nothing was sent)

  Blocked actions   : 4  (claude-code 4)
  Secrets hidden    : 1  (AWS_KEY 1)
  New MCP servers   : 0  (only servers wrapped by zn-gate are listed)

  Busiest day: 2026-11-11 (4 blocked)

This report was built from files on your computer. Nothing left it.
```

Read the numbers against what you did that day. Four blocks on a day when you asked your agent to touch a `.env` file, a key file and a system folder are the hooks doing their job. Four blocks on a day when you only asked for a README change are worth a question to your agent. The command shows the busiest day of the period.

### 3. Look at one block in the log: `zn evidence`

```bash
zn evidence
```

```text
[+]  zn Evidence Ledger Stats (<home>/.zn/evidence.jsonl)
---------------------------------------------------
  Total Events  : 4
  Blocked Drops : 4
  Allowed Passes: 0
  Shadow Alerts : 0
  Integrity     : VALID
---------------------------------------------------
Recent Events (last 4):
  11:50:31 [BLOCK] tool=user_prompt rule=hook-user_prompt-secret hash=e983be117a...
  11:50:31 [BLOCK] tool=bash rule=hook-pre_tool-policy hash=d083ef32eb...
  11:50:30 [BLOCK] tool=read rule=hook-pre_tool-policy hash=4740072e17...
  11:50:30 [BLOCK] tool=bash rule=hook-pre_tool-policy hash=921a7c23c2...
```

Only blocks are in the log (`Allowed Passes: 0`: the allowed `ls -la` is not there). The list shows the newest first, with the time, the tool and the rule, but not the id. To explain an earlier block, find its id in the export and give it to `why`:

```bash
zn evidence --export | grep -o '"id":"[^"]*"'
```

```text
"id":"ev_mwc24zjb_1e91a86b"
"id":"ev_mwc24zll_542066e5"
"id":"ev_mwc24znw_93340bdd"
"id":"ev_mwc24zt3_b954f7b4"
```

The export lists the oldest block first, so the first id is the block of `cat .env`:

```bash
zn why ev_mwc24zjb_1e91a86b
```

```text
zn blocked this at 2026-11-11T11:50:30.887Z (UTC).
  Record:  ev_mwc24zjb_1e91a86b
  What:    a tool call, checked by the zn hook before it ran, tool "bash" (agent: claude-code)
  Preview: {"event":"pre_tool","tool":"bash","kinds":[]}   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)
```

The output goes on to say that the log does not keep which check of the hook fired, so there is no single command to give. For this kind of block, the message your agent showed you is where the reason is: it ends with a rule name in brackets such as `(rule: secret-file:dotenv)`. Find it in the [troubleshooting page](../troubleshooting.md#block-and-warn-reasons-by-family) or in [Block message anatomy](block-message-anatomy.md).

## At the end of the week

Run the weekly view and check the log:

```bash
zn report
zn evidence --verify
```

`report` covers the last 7 days by default. `evidence --verify` checks the chain of hashes of the log, so you know that nobody changed a line:

```text
[ok] Cryptographic Evidence Ledger Verification:
  Ledger Path   : <home>/.zn/evidence.jsonl
  Total Records : 4
  Integrity     : [ok] ALL SHA-256 HASHES VERIFIED (IMMUTABLE)
```

Then decide what to do with what you saw:

| What you saw | What to do |
| --- | --- |
| Blocks you expected, once each | Nothing. This is the hooks working. |
| The same secret type again and again | Move the value to the vault with `zn secret set NAME` and ask your agent to use the `__ZN_NAME__` marker. See [Keep a secret out of the agent](keep-a-secret-out-of-the-agent.md). |
| A block you did not expect | Ask your agent why it wanted that file or command. Do not look for a way around the block. |
| A block that stops work you want to do | Run the step in the message in your own terminal. Do not reword the request to get past it. |
| `Integrity` is not valid | Run `zn evidence --verify`: it says what is wrong, and the [troubleshooting page](../troubleshooting.md) has the steps for a damaged log. |

## See also

- [Examples: stats and report](stats-and-report.md): more outputs of the two commands.
- [Why was this blocked?](../why-was-this-blocked.md): five common messages and how to go on safely.
- [`why` in the command line reference](../cli.md#why)
