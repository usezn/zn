# Example: running status and test on a new machine

Two commands tell you, on a computer where you just installed zn-gate, which version you run and whether its rules work there: `status` and `test`. This page runs both and reads their output line by line. The options and exit codes are in the command line reference: [`status`](../cli.md#status) and [`test`](../cli.md#test). The outputs below are samples: your version, rules version and times will differ.

Neither command needs an agent to be set up, and neither sends anything over the network. To check that zn protects your agents, run `npx -y zn-gate check` instead: see [Check that it works](../check.md).

## Run them

```bash
npx -y zn-gate status
npx -y zn-gate test
```

If you installed zn-gate for your user (`npm install -g zn-gate`), `zn-gate status` and `zn-gate test` do the same. On Windows PowerShell, use `npx.cmd` (more in the [Windows checklist](windows-checklist.md)).

## What `status` prints

On a new machine, with no cloud check set up:

```text
[+]  zn-gate Status:
  Package Version : 1.15.0
  Rules Version   : 2026-10-28.1 (scrub 2026-10-24.1, audit 2026-10-23.8)
  Active Engine   : Local rules only
  Endpoint        : None (nothing leaves this machine)
  API key         : Not set
  Leaves machine  : Nothing
```

`status` reads your settings and the saved key, if any; it opens no network connection and changes nothing. It does not check that the endpoint it shows can be reached. It always exits `0`, so its exit code tells you nothing; read the lines.

### `Package Version`

The version of zn-gate that ran. Give it when you ask for help. `zn-gate --version` prints it too.

### `Rules Version`

The version of the detection rules, then the versions of the rules that `scrub` and `audit` use. `zn-gate --version` prints them too.

### `Active Engine`

`Local rules only` means zn decides with its built-in rules on your machine. This is the default. If it reads `Local rules + cloud for analyze_prompt (ZN_CLOUD=1)`, the optional cloud check is on, because you set `ZN_CLOUD=1` together with an API key or ran `zn-gate connect`. See [Reading the Active Engine line](../check.md#reading-the-active-engine-line).

### `Endpoint` and `Leaves machine`

With local rules only, `Endpoint` says `None (nothing leaves this machine)` and `Leaves machine` says `Nothing`. With the cloud check on, `Endpoint` shows where the text goes and `Leaves machine` says `analyze_prompt text only, secrets redacted locally first`. What the cloud check sends is in [Local checks and API data](../local-checks-and-api-data.md).

### `API key`

`Not set` means no key is set and none was saved by `zn-gate connect`. The line never shows the key itself. If you set `ZN_API_KEY` without `ZN_CLOUD=1`, it reads `Set (ZN_API_KEY) (unused: cloud requires ZN_CLOUD=1)` and the engine stays local. To try it with a fake value:

```bash
ZN_API_KEY=example-fake-key npx -y zn-gate status
```

`ZN_LOCAL_ONLY=true` keeps the engine local even when `ZN_CLOUD=1` and a key are set.

### A warning about hooks

On a new machine there is none. Later, if an installed hook was written by an older zn-gate, `status` adds one warning that names each agent and the command that refreshes it (`zn hooks install <agent>`, with `--project` for project hooks). When all hooks are current, it prints nothing about hooks.

## What `test` prints

`test` runs the local self-test: 51 built-in examples, 26 attacks and 25 ordinary developer texts. It checks the rules on your machine, not your agent setup. A shortened sample:

```text
[+]  Running zn-gate v1.15.0 Self-Test Suite
Engine: Local rules (the self-test never uses the network) | Rules: 2026-10-28.1
Evaluating 51 curated test vectors (26 attacks + 25 benign developer scenarios)...

  [ok] [2.95ms] BLOCKED Disregard instructions (Disregard instructions)
  [ok] [0.33ms] ADVISORY Fake <system> XML tag (Fake system tag)
  ...
  [ok] [0.30ms] ALLOWED React useState hook import
  ...

-----------------------------------------------------------------------------
Summary         : 51/51 vectors passed (100.0%)
False Positives : 0 of 25 curated benign vectors (not a general false-positive rate)
Average Latency : 1.269 ms per decision
Status          : ALL TESTS PASSED (100%)
-----------------------------------------------------------------------------
```

### The first three lines

The title names the version that ran. `Engine` repeats that the self-test uses only the local rules and never the network, and `Rules` is the rules version, the first value of `Rules Version` in `status`. The third line gives the number of examples.

### One line per example

Each line starts with `[ok]` when the example gave the expected result, then the time zn took to decide, the result and the name of the example. The text in brackets at the end is the reason zn gave.

- `BLOCKED`: zn blocked the text.
- `ADVISORY`: zn did not block the text but flagged it with a warning.
- `ALLOWED`: zn let the text through. Ordinary developer texts should end here.

An attack example passes when it is blocked or flagged; an ordinary text passes when it is not blocked. An example that does not give the expected result starts with `[x]` and `FAILED`, and says what was expected and what zn returned.

When the output goes to a terminal, the markers can be symbols instead of `[ok]`, `[x]` and `[+]`; the words carry the same meaning in every mode (see [Settings at a glance](../cli.md#settings-at-a-glance)).

### The summary

- `Summary`: how many examples passed.
- `False Positives`: how many of the ordinary texts were blocked. It counts only these 25 examples, so it is not a false-positive rate for your own work.
- `Average Latency`: the average time per decision on this machine.
- `Status`: `ALL TESTS PASSED (100%)`, or `FAILURES DETECTED` when at least one example failed.

The self-test is a smoke test, not a detection rate.

### The exit code

`0` when all examples passed, `1` when at least one failed. If one fails, run `npx -y zn-gate init` again, then repeat the check, as [First 5 minutes](../first-5-minutes.md#2-check-that-it-worked) says.

## With the Python package

`pip install zn-gate` has a `status` command too. It shows the version, the rules version, the Python version and whether the optional cloud check is on. Its `test` is different: it checks one text you give it, for example `zn-gate test "hello from example.com"`, and does not run the self-test. See [The Python package](../cli.md#the-python-package).

## Next steps

- [Command line reference](../cli.md): the full page, with [`status`](../cli.md#status) and [`test`](../cli.md#test).
- [Check that it works](../check.md): check that zn protects your agents.
- [Reading a check output line by line](check-output-explained.md)
- [After an upgrade](after-an-upgrade.md)
