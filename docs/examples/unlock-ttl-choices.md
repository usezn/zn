# Example: choosing how long the vault stays unlocked

When you unlock the vault, you choose two limits: how long the session may last in total (`--ttl`), and how long it may sit unused (`--idle`). The vault locks at whichever limit comes first. This page shows four typical choices, what happens when the time runs out, and how to lock early or check the time left. For every option, read the [CLI page](../cli.md#unlock) and the [secrets page](../secrets.md).

The output below comes from real runs of the commands against a throwaway vault, with a made-up test passphrase. Two things were changed for reading: the command is shown as `zn-gate` (your machine prints the form that works there, for example `npx -y zn-gate@<version>`), and the test runs used short values (2 minutes, 1 minute) so that they finished in minutes. The values in the four examples are the ones you would use.

## The two limits

| Option | Default | Allowed values | What it counts |
|---|---|---|---|
| `--ttl` | `8h` | 1 minute to 24 hours | The whole session, counted from the moment you unlock. Use never extends it. |
| `--idle` | `30m` | 1 minute to 24 hours | The time with no request to the vault. Each request restarts it. |

Values are a number followed by `s`, `m` or `h`, for example `90m` or `4h`. Anything else, such as `1d` or a value outside the range, is refused before the vault is touched, with exit code `2`.

A request to the vault is anything the running vault answers, including a status check. In a test run, the vault was unlocked with a one-minute idle limit. A status check at about 30 seconds kept the vault open at about 70 seconds, which it would not have done if the status check had not restarted the idle clock.

## Four typical choices

**1. A shared machine, a short session.** Use a short total time and a short idle time, so the vault locks soon after you leave:

```text
zn-gate unlock --ttl 1h --idle 15m
```

Real output of this command:

```text
Vault unlocked: locks after 15 min idle, or at 16:24 (in 60 min) at the latest. Run `zn-gate lock` to lock now.
```

**2. The default, for a working day.** Without any option, you get 8 hours in total and 30 minutes without use:

```text
zn-gate unlock
```

Real output with the defaults:

```text
Vault unlocked: locks after 30 min idle, or at 23:24 (in 8 h) at the latest. Run `zn-gate lock` to lock now.
```

**3. A long build or an overnight job.** Raise the total time to the 24-hour maximum, and allow a longer idle time so that a quiet build step does not lock the vault:

```text
zn-gate unlock --ttl 24h --idle 2h
```

Both limits run at the same time, and the earlier one wins. An `--idle` longer than the `--ttl` therefore changes nothing: the session still ends at the `--ttl` time.

**4. Keep the default total time, shorten the idle time.** If you work in bursts on your own laptop and want the vault closed while you step away, keep the 8-hour total and lower the idle time:

```text
zn-gate unlock --idle 10m
```

Shorter limits leave less time for someone else to use an open vault, so choose the shortest ones that cover your work.

## Check the time left

`zn-gate vault status` shows the same two limits for the running vault:

```text
Vault: unlocked (backend passphrase, locks after 15 min idle, or at 16:24 (in 60 min) at the latest, zn-gate 1.15.0)
```

The line gives the idle rule and the clock time of the total limit, with the time left. It does not show a countdown for the idle limit: that limit is counted from your last request.

## What happens when the time runs out

When the vault locks by itself, `zn-gate vault status` reports it as locked:

```text
Vault: locked (backend passphrase)
```

The reason is printed only in the terminal of `zn-gate unlock --foreground`, where the vault runs in your own window. Its two messages are "it was not used for 15 min" for the idle limit and "the time you set with --ttl ran out" for the total limit.

While the vault is locked, a command that needs a secret fails with the locked message. In a test run, `zn-gate secret list` printed:

```text
zn secret: Your secret vault is locked. Unlock it in this terminal with: npx -y zn-gate@1.15.0 unlock. Then run this command again.
```

Only you can unlock the vault. Running `unlock` from an AI agent is refused, and the refusal says the command must be run in your own terminal, so the agent cannot unlock it on its own.

## Lock early

When you finish, lock the vault yourself instead of waiting for the limits:

```text
zn-gate lock
```

Real output:

```text
Vault locked.
```

If the vault is already locked, the command still exits with code `0` and says so:

```text
Vault was not unlocked.
```

To change the limits of a session that is open, lock it first and then unlock it again with the new values. A second `unlock` while the vault is open does nothing:

```text
The vault is already unlocked, so there is nothing to do. To unlock it again, run `zn-gate lock` in your own terminal first.
```

## Related pages

- [Secrets](../secrets.md): what the vault stores and how secrets reach your tools.
- [CLI reference](../cli.md#unlock): every option of `unlock`, and `lock` and `vault status`.
