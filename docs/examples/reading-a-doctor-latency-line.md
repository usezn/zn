# Example: reading the decision-time line of `zn check`

`zn check` (also called `zn doctor`) ends with one line about speed: how long zn takes to decide each tool call. This page shows the three forms of that line, what its two numbers mean, and what to look at when they look high. The output below was captured from the real command in a throwaway home folder with a fake project. Only the times depend on the machine.

For the rest of the output, see [What `zn check` shows](../check.md) and [Check output explained](check-output-explained.md). For the benchmark behind the numbers on this page, see [Performance of the agent hooks](../performance.md).

## The line, with data

After the hook for Claude Code had decided 40 tool calls, `zn check` printed this as its last block (the lines about each agent come before it):

```text
Decision time per tool call (last 40 calls, measured on this machine): p50 17.5 ms, p95 22.5 ms. Excludes process startup, writing the response, and saving stats and evidence.
Hooks: 6 OK, 0 stale, 0 broken. Run zn check --hooks for details.
```

In this run the hints printed `npx -y zn-gate@1.15.0 ...` because `zn` was not on the PATH; this page shows `zn`.

| Part | What it tells you |
| --- | --- |
| `last 40 calls` | How many stored times the numbers come from. zn keeps the last 100, so this never goes above 100. |
| `measured on this machine` | The times are your machine's own. They are kept in `stats.json` in your `.zn` folder as numbers only, never a command, a path or a name. |
| `p50 17.5 ms` | The median: half of the 40 calls were decided faster than this, half slower. It is the usual wait. |
| `p95 22.5 ms` | Nearly the slowest: 95 in 100 calls were as fast as this or faster. It is the wait on a slow call. |
| `Excludes ...` | The clock runs from the moment zn starts deciding until it has decided. Starting the process, writing the answer to your agent and saving stats and evidence are not in it. |

Both numbers use the nearest-rank method: sort the times and take the one at that position. With fewer than 20 calls, p95 is simply the slowest call. In this run the 40 stored times ran from 13.7 to 27.6 ms, so a p95 of 22.5 ms is the 38th time of 40.

Calls are counted per tool call, before and after it: the line covers the decisions on events before a tool runs and after it returns with its output.

## The two other forms

Before zn has checked any tool call, there is nothing to show:

```text
Decision time per tool call: no data yet. It is measured on each tool call your agent makes through zn.
```

This is normal on a new setup. Use your agent for a task, then run `zn check` again. Running `zn check` itself does not add a time: the count stayed at 40 after it had run.

With `ZN_STATS=off` in the environment, zn does not record anything:

```text
Decision time per tool call: off (ZN_STATS=off), nothing is measured.
```

Remove the variable (and see [Files and folders](../files-and-folders.md) for where the numbers are kept) to measure again.

## The 100-call window

After 70 more calls on top of the first 40, the line said:

```text
Decision time per tool call (last 100 calls, measured on this machine): p50 15.0 ms, p95 21.0 ms. Excludes process startup, writing the response, and saving stats and evidence.
```

The 10 oldest times had been dropped, and the stored list held exactly 100 times. The window moves with your use, so one slow afternoon fades out after 100 more calls.

## If the numbers look high

1. **Do not compare with the whole delay your agent sees.** Each hook is a short Node.js process, and starting it is not in this line. A bare `node -e ""` took 24 ms on the benchmark runner, and the benchmark times in [Performance of the agent hooks](../performance.md#results) (54 ms for a shell command) include it. The line on this page is smaller by design.
2. **Look at the gap between p50 and p95.** A p50 that is fine with a high p95 means a few calls were slow, not all. Large tool outputs are slower to check: in the benchmark, a 1000 KB output took about 80 ms and a 1 KB output about 57 ms.
3. **Give it more calls.** With a handful of calls, one slow one decides p95. After 100 calls the line is steady.
4. **Check that nothing is stale or broken.** The `Hooks:` line under it says so; `zn check --hooks` lists each hook and the command that fixes it. See [List every installed hook](../check.md#list-every-installed-hook).
5. **If you also see `The vault is not answering`**, follow [Troubleshooting](../troubleshooting.md).

If it stays high on a normal machine after these steps, open an issue and include the line.
