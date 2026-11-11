# Example: a five-minute weekly review with zn-gate stats

Once a week, look at what zn-gate did on your computer and confirm it still protects your agents. The routine takes about five minutes and uses four commands. All numbers below are made up. For every option and exit code, see the [command line reference](../cli.md#stats).

Everything here reads counts kept on your computer. Nothing is sent.

## Goal

Find out whether anything unexpected was blocked in the last 7 days, understand the one block that matters most, and confirm that the agents you use are still protected.

## 1. Read the last 7 days

```bash
zn-gate stats --days 7
```

```text
zn-gate on this machine, last 7 days (counting since 2026-11-05):

  412 events checked (prompts, tool calls and tool results)
  12 blocked (a secret file read, a pasted secret, a prompt injection or a risky call)
  31 secret values replaced before the model saw them

  Secret types found: AWS_KEY 14, DB_PASSWORD 8, GITHUB_TOKEN 6, JWT 3, EMAIL 2

  Top rules, last 7 days:
    AWS_KEY  Built-in detector  9
    DB_PASSWORD  Built-in detector  4
  Most frequent: AWS_KEY. To understand your last block, run: zn-gate why
```

Look at three things:

- **Blocked count.** `blocked` is how many actions zn-gate stopped. A number that is much higher than last week is worth a look. A count of zero is normal if you did not use an agent.
- **Top rules.** These are the detector ids that matched most often, with their counts. The name is always `Built-in detector` for now, so read the id (for example `AWS_KEY`). A single id that dominates usually means one kind of file or command keeps tripping it.
- **Detections.** The secret types found, and the number of secret values replaced before the model saw them. A type you did not expect, such as a database password in a folder you thought was clean, is worth a closer look.

If the output says `Nothing recorded yet`, zn-gate has not checked anything on this computer yet. Go to step 3 to confirm that your agents are set up.

`--days` changes the window for the counts. The default is 30 days, so leave `--days 7` in place for a weekly review. The `Top rules` block also covers 7 days by default.

## 2. Explain the latest block

If the blocked count is above zero, explain the most recent one:

```bash
zn-gate why
```

With no id, it explains the last block. The output says what was stopped, which rule fired, why that matters, and the one command you can run to go on, when such a command exists. For a rule that cannot be bypassed, it says so and who decides.

When no block has been recorded, it says so and exits with `1`:

```text
zn why: there is no evidence log yet, so no block has been recorded on this computer.
```

To explain an older block, take its `id` from `zn-gate evidence --export --format jsonl` and run `zn-gate why <id>`. The command only reads the log. For what the exit codes mean, see [the why command](../cli.md#why).

The `why` command is in the npm package. The Python package does not have it; its [troubleshooting page](https://usezn.com/docs/zn-gate/troubleshooting/) explains how to check a block instead.

If the same rule keeps blocking something you need, read [when to allow an action and when to change a setting](first-block-vs-allow-decision.md) before you change anything.

## 3. Confirm that the agents are protected

```bash
zn-gate check
```

The check runs a fake secret through each agent you have set up, in a temporary folder. Nothing is sent and no setting changes.

- Exit code `0`: every agent that is set up is protected.
- Exit code `1`: an agent is not protected, or none is set up. The output names the agent. Fix that first, then run the check again.

Near the end, the output shows the decision time per tool call. Before your agent has made any tool call on this machine, it says `no data yet`. That is normal for a new install.

## 4. Optional: keep the numbers for a script

To store the week's numbers, for example in a notes file, use JSON:

```bash
zn-gate stats --days 7 --json
```

The object has the same counts as the text output, plus `top_rules` (the same five rules as a list), `top_rules_days` (the window of that list, `7` here) and `sharing` (`false` unless you turned sharing on). A week with no matches shows `"top_rules": []`.

## When to stop

Five minutes is enough when the counts match what you expected and `check` exits with `0`. Dig deeper only when a number surprises you: a new secret type, a block you do not recognise, or a `check` that exits with `1`.

## See also

- [Command line reference: stats](../cli.md#stats): all options and exit codes.
- [Weekly report and stats examples](stats-and-report.md): longer periods and the `report` command.
- [Read the output of zn why](zn-why-allow-command.md): what the explanation means and the command it gives you.
