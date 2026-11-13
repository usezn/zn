# Example: read the top rules in stats

`zn-gate stats` ends its numbers with a `Top rules` block. This page shows a real output, says what each count is and is not, and shows how to find out which tool or event is behind a rule that shows up too often. All values are made up. For every option and exit code, read the [command list](../cli.md#stats); the shorter walk-through of the same block is in [Examples: stats and report](stats-and-report.md#top-rules-in-stats).

Run every command here in your own terminal. All of them only read counts and logs on your computer: nothing is changed and nothing is sent.

## Where the numbers come from

The output below is from a throwaway home folder. Nine events were given to the Claude Code hook as text, the way an agent sends them, and no command was run:

- three attempts to read a `.env` file that holds a fake key (all blocked);
- two prompts that held a fake GitHub token (both blocked);
- four tool results that held a fake key and a fake token (allowed, with both values replaced).

## The output

```bash
zn-gate stats
```

```text
zn-gate on this machine, last 30 days (counting since 2026-11-11):

  9 events checked (prompts, tool calls and tool results)
  5 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  8 secret values replaced before the model saw them

  Secret types found: GITHUB_TOKEN 6, ENV_VALUE 4

  Top rules, last 7 days:
    GITHUB_TOKEN  Built-in detector  6
    ENV_VALUE  Built-in detector  4
  Most frequent: GITHUB_TOKEN. To understand your last block, run: zn why

  By agent:
    claude-code (agent hooks): 9 events, 5 blocked, 8 replaced
```

## What each count means

- **`5 blocked`** counts actions that were stopped: here the three `.env` reads and the two prompts.
- **`8 secret values replaced`** counts values that were swapped for a marker before the model saw them: here two values in each of the four tool results.
- **`Top rules`** counts how often each detector id matched a secret in text: `GITHUB_TOKEN` 6 is two prompts plus four tool results, and `ENV_VALUE` 4 is the four tool results. It is a count of matches, not of blocks, so it does not add up to the `blocked` line. The three `.env` reads were blocked and added nothing to it.
- Only the detector id, the generic label `Built-in detector` and the count are shown, never a value, a path or a command. The block covers the last 7 days; `--days` changes that, and it is left out when nothing matched in the window.

## Spot a noisy rule

A rule is noisy when it tops the list again and again and you did not expect it. Here `GITHUB_TOKEN` is 6 of the 10 matches. A value that keeps turning up in tool results usually means a command or a file keeps printing a secret, so the cause is the tool and not the detector. To find it:

1. Narrow the window to see whether it is recent: `zn-gate stats --days 1`.
2. List the recent events with the tool and the rule of each:

   ```bash
   zn-gate evidence
   ```

   ```text
   [+]  zn Evidence Ledger Stats (~/.zn/evidence.jsonl)
   ---------------------------------------------------
     Total Events  : 9
     Blocked Drops : 5
     Allowed Passes: 4
     Shadow Alerts : 0
     Integrity     : VALID
   ---------------------------------------------------
   Recent Events (last 9):
     11:17:29 [BLOCK] tool=read rule=hook-pre_tool-policy hash=7c497a770f...
     11:17:29 [BLOCK] tool=read rule=hook-pre_tool-policy hash=da742d9841...
     11:17:29 [BLOCK] tool=read rule=hook-pre_tool-policy hash=049a8d1df3...
     11:17:29 [BLOCK] tool=user_prompt rule=hook-user_prompt-secret hash=baa5dcc757...
     11:17:29 [BLOCK] tool=user_prompt rule=hook-user_prompt-secret hash=645463d208...
     11:17:29 [ALLOW] tool=bash rule=hook-redacted-output hash=a7525a178f...
     11:17:28 [ALLOW] tool=bash rule=hook-redacted-output hash=f74a52e24d...
     11:17:28 [ALLOW] tool=bash rule=hook-redacted-output hash=2b7c1ea60f...
     11:17:28 [ALLOW] tool=bash rule=hook-redacted-output hash=8392c01179...
   ```

   Here the four values come from `tool=bash` results (`hook-redacted-output`): something in your shell commands prints the secret. The `Recent Events` list is the place where a repeated tool shows up.
3. Explain the last block in words with `zn why`:

   ```bash
   zn-gate why
   ```

   ```text
   zn blocked this at 2026-11-11T11:17:29.568Z (UTC).
     Record:  ev_mwc0yiqo_b2123555
     What:    a tool call, checked by the zn hook before it ran, tool "read" (agent: claude-code)
     Preview: {"event":"pre_tool","tool":"read","kinds":[]}   (as stored in the log, with secrets already removed)
     Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)
   ```

   `zn why` explains blocks only. A value that was replaced in a tool result is not a block, so it appears in `evidence` but not here. When the log does not say which check fired, `zn why` says so and points to the [troubleshooting page](../troubleshooting.md#block-and-warn-reasons-by-family). For a worked example, read [Examples: allow a blocked action after `zn why`](zn-why-allow-command.md).

## What to do about it

`stats` only counts: it never changes a rule. If a tool keeps printing a secret, stop it at the source: keep the value in the vault and have the command read it from there (see [Example: keep a secret out of the agent](keep-a-secret-out-of-the-agent.md)), or fix the script that prints it. If the counts look right and you only want to read them better, use the [report](stats-and-report.md#weekly-report).

## The same list in JSON

```bash
zn-gate stats --json
```

The list is in `top_rules`, highest count first, and its window in days in `top_rules_days`. This is that part of a real run:

```json
{
  "top_rules_days": 7,
  "top_rules": [
    { "id": "GITHUB_TOKEN", "name": "Built-in detector", "count": 6 },
    { "id": "ENV_VALUE", "name": "Built-in detector", "count": 4 }
  ]
}
```

`top_rules` is an empty list when nothing matched. `name` is always `Built-in detector` for now.

## Related

- [Examples: stats and report](stats-and-report.md): the same commands in short.
- [Example: reading a check output line by line](check-output-explained.md): another output explained.
- [Examples](README.md): the list of all example pages.
