# Example: recovering when your team policy has expired

`zn team status` says `EXPIRED` or `STRICT MODE` on the `Policy:` line. This page shows what that looks like, how to tell the two causes apart (this computer was offline too long, or its clock is wrong), and the steps that bring a fresh policy. Organization, key, dates and counts below are made up. For the full description of zn Team, see [zn Team](../team.md#offline-expiry-and-removal).

A policy is valid for 7 days from the day the server signs it. While you are online and the vault is unlocked, zn fetches a new one by itself, so an expired policy means zn could not do that.

## What you see

The state was made with a throwaway key and a made-up organization, with the real `zn team status` reading it. No server was contacted. The policy was issued 10 days ago and ended 3 days ago. At that moment it was `2026-11-08T13:49:27Z` in UTC:

```bash
zn team status
```

```text
Organization: Example Org (org_Example12345678)
Installation: inst-0001 via https://team.example.com
Policy:       version 12, valid until 2026-11-05T13:49:27.743Z -- EXPIRED: strict mode (only restrictions apply) until zn can reach the server. If this computer is online, check its date and time.
Audit upload: 0 records pending
The vault is locked: policy downloads and uploads resume after `zn unlock`.
```

Two things to notice: the `valid until` date is in the past, and the vault is locked, so nothing is downloaded until you unlock it. (In this run the hint printed `npx -y zn-gate@1.15.0 unlock` because `zn` was not on the PATH; this page shows `zn`.)

For the rules, `zn team status --rules` reads only the saved copy and says it will not show rules from an expired policy:

```text
Rules: The saved policy (version 12) expired on 2026-11-05T13:49:27.743Z, so it is not active and no rules are shown from it. Only restrictions apply until a new policy arrives; run `zn team sync`.
```

The same state with `zn team status --json` has `"state": "expired"` under `policy`.

## What strict mode means in the meantime

Strict mode keeps what restricts and withdraws what the organization had opened:

- A rule that **denies** a secret, or sets `mode: proxy`, or limits the commands, hosts or place a value may go, still applies.
- A host that the organization had opened for a secret is no longer offered. An approval you already gave for it does not bring it back.
- The base protections of zn-gate (credential files, `~/.zn`, agent configuration) never depended on the policy and are unchanged.

This comes from the policy code (`lib/team/effective.js`: "the strict mode keeps what restricts and withdraws what the organization had opened, approved or not") and from the [offline table](../team.md#offline-expiry-and-removal). It was read from the source, not run for this page.

## Step 1: compare the dates

Read the `valid until` date on the `Policy:` line (it is in UTC) and compare it with the current time in UTC. On Linux and macOS:

```bash
date -u
```

On Windows, open the clock in the settings, with the time zone, and convert.

| What you find | Cause | Go to |
| --- | --- | --- |
| The clock is right and `valid until` is days ago | This computer was offline, or the vault locked, for longer than a policy lasts | [Step 2](#step-2-unlock-and-sync) |
| The clock shows a date later than the real one | The clock is ahead, so a good policy looks old | [Fix the clock](#when-the-clock-is-wrong) |
| The `Policy:` line says `STRICT MODE ... this computer's clock is behind` | The clock is behind the time the policy was issued | [Fix the clock](#when-the-clock-is-wrong) |

## Step 2: unlock and sync

Unlock the vault, then fetch the policy at once instead of waiting for the next automatic sync (a few seconds after `zn unlock`, then every 15 minutes):

```bash
zn unlock
zn team sync
```

This needs the network and a server, so it could not be run for this page. On success, the first line of the output is, as written in the source, `Policy: current (version 12)` when the saved version is still the newest, or `Policy: updated (version 13)` when a newer one came down. If the machine still cannot reach the server, the command says so, changes nothing and exits with `1`.

## Step 3: check it worked

```bash
zn team status
```

The `Policy:` line should end at a `valid until` date in the future, with no `EXPIRED` and no `STRICT MODE`. The audit records that waited on your machine are sent on the same sync.

## When the clock is wrong

A policy is refused when its dates do not fit your clock, and the reason is written in plain words. When the clock is ahead, a sync reports this reason (quoted from the source, `lib/team/sync-outcome.js`, not captured):

- `the downloaded policy was refused (policy expired): this computer's clock may be ahead, so check its date and time`

When the clock is behind, `zn team status` shows the `STRICT MODE` line, so the rules stay restricted until the clock is right. It was captured with a saved policy issued two days from now:

```text
Policy:       version 12, valid until 2026-11-13T13:49:28.132Z -- STRICT MODE (only restrictions apply): this computer's clock is behind the time this policy was issued. Check the computer's date and time.
```

Set the date, time and time zone from your system settings, and turn on automatic time. Then run [Step 2](#step-2-unlock-and-sync) again. A small difference does not matter: zn accepts a clock that is up to five minutes off in either direction.

## If it does not recover

- `zn team sync` keeps failing with the vault unlocked and the clock right: see [Troubleshooting](../troubleshooting.md) for the message that it prints, and run it again with `ZN_VERBOSE=1` to see the technical cause.
- `zn team status` says the machine was removed from the organization: ask your admin. Strict mode will apply once the saved policy runs out.
- For the whole picture of zn Team in a few pages, see the [team quick guide](../team-quick-guide.md).
