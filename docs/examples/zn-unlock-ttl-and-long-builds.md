# Example: set the unlock time for a long build

`zn unlock` keeps the vault open for 8 hours, or until 30 minutes pass without use. For a build or a test run that is longer than that, or that calls `zn run` again and again with long gaps between the calls, you may want other limits. This page shows what the two options do, with real output, and how to pick values. All names and values are made up.

The output was printed on a test computer with a temporary home folder. The clock times are the local time of that computer.

## The two limits

```bash
npx -y zn-gate unlock --ttl 6h --idle 2h
```

```text
Vault unlocked: locks after 120 min idle, or at 19:13 (in 6 h) at the latest. Run `npx -y zn-gate@1.15.0 lock` to lock now.
```

- `--ttl` is the most time the vault stays open, whatever the use. The default is `8h`. When it runs out, the vault locks, even while you are using it.
- `--idle` is how long the vault may sit unused. The default is `30m`. Every request to the vault (a `zn run`, a `secret list`, a `vault status`) starts the count again.

Both take a whole number and `s`, `m` or `h`, and must be between 1 minute and 24 hours. Others are refused with exit code `2` and nothing is unlocked:

```text
[zn] The --ttl and --idle times must be between 1m and 24h, for example 8h.
[zn] invalid duration "2d" (use e.g. 30m, 8h)
```

The first line is what `--ttl 30s` and `--ttl 25h` print. The second is what `--ttl 2d` prints.

To check what is running now:

```bash
npx -y zn-gate vault status
```

```text
Vault: unlocked (backend passphrase, locks after 120 min idle, or at 19:13 (in 6 h) at the latest, zn-gate 1.15.0)
```

(A second line names the folder of the vault and is left out here.) You cannot change the limits of a vault that is already open. A second `unlock` stops with `The vault is already unlocked, so there is nothing to do.` and exit code `1`. Run `lock` first, then unlock again with the new values.

## What happens to a command that is already running

The vault gives a secret to a program when `zn run` starts it. A test with `--ttl 2m` shows what that means. A script was started with `zn run` just after the unlock. It checks that the key is in its environment, sleeps for 150 seconds, and checks again. It wrote one line to a file at each check:

```text
13:10:05 step 1: key present
13:12:35 step 2: key present
```

The vault had said `locks after 30 min idle, or at 13:12 (in 2 min) at the latest`, so it was locked half a minute before the second line. `vault status` right afterwards said:

```text
Vault: locked (backend passphrase)
```

The running program kept what it had been given and ended normally, with exit code `0`. What the lock stops is the next request. A second `zn run` after the lock stops with exit code `1` and runs nothing:

```text
zn run: Your secret vault is locked. Unlock it in this terminal with: npx -y zn-gate@1.15.0 unlock. Then run this command again.
```

So the choice depends on the shape of the work:

| Your work | What to set |
|---|---|
| One long command, started once | The default is enough. The vault is only needed when the command starts. |
| Many `zn run` calls over several hours | `--ttl` longer than the whole task, for example `--ttl 6h`. |
| Calls with long quiet gaps, such as a 90-minute test suite between steps | `--idle` longer than the longest gap, for example `--idle 2h`. |

Use the shortest values that cover the task. The longer the vault stays open, the longer a program you allowed can ask it for a secret.

## Why it locked: the log

`zn vault log` records each lock with its reason. With `--ttl 1m` the vault locked when the time ran out:

```bash
npx -y zn-gate vault log
```

```text
2026-11-11T12:57:57.670Z  allow  -  unlock  -  -    ttl:1m
2026-11-11T12:58:57.715Z  allow  -  expire  -  -    expired
```

With `--idle 1m` and two uses 40 seconds apart, the vault stayed open for those uses and locked about a minute after the last one:

```text
2026-11-11T12:59:09.847Z  allow  -  unlock  -  -    ttl:480m
2026-11-11T13:01:30.169Z  allow  -  expire  -  -    idle
```

The time on an unlock line (`ttl:480m`) is the `--ttl`, in minutes. The last word of a lock line is `expired` for the `--ttl` and `idle` for the `--idle`. While the vault is locked, `vault log` ends with `chain: not checked`, because it needs the unlocked vault to check the chain.

## Lock it when the build is done

```bash
npx -y zn-gate lock
```

```text
Vault locked.
```

Running `lock` again prints `Vault was not unlocked.` and still exits with `0`.

## See also

- [Store a secret and run a program that uses it](secret-set-and-run.md): the unlock, the first-use approval and `run`.
- [Command line reference: `unlock` and `lock`](../cli.md#unlock)
- [Keep secrets out of your coding agent](../secrets.md)
- [All examples](README.md)
