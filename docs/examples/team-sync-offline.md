# Examples: `zn team sync` without a network

What happens when you run `zn team sync` on a machine that cannot reach the zn server, and what zn-gate keeps working with in the meantime. All dates, versions and counts below are made up. For the full description of zn Team, see [zn Team](../team.md#offline-expiry-and-removal); for the command, see the [command line reference](../cli.md#team-sync).

There is no separate offline mode and no flag for it. `zn team sync` always tries to reach the server; when it cannot, it says so, changes nothing and exits with `1`.

## What `zn team sync` does when you are offline

```bash
zn team sync
```

```text
[zn] Could not reach the zn server. Nothing was changed. Check your internet connection and run again: zn team sync
```

That message goes to standard error, and the exit code is `1`. Run `echo $?` (or `echo %ERRORLEVEL%` in Command Prompt) to see it. The technical cause (for example an HTTP status or an internal code) is shown only when you set `ZN_VERBOSE=1`.

The vault must be unlocked for a sync (`zn unlock`). While it is locked, nothing is downloaded or uploaded.

## What keeps working: the saved policy

Each time a sync works, zn saves the organization policy on your machine, and the hooks and the vault keep using that saved copy. The hooks read two files in your `~/.zn` folder, `team.json` and `org-policy.json`, and check the policy again with the key pinned when you joined. They do not need the network.

| Situation | What happens |
| --- | --- |
| No network, the saved policy is still valid (a policy is valid for 7 days) | The policy keeps applying. |
| No network for longer than the policy is valid | Strict mode: the restrictions keep applying, and anything the organization had opened is withdrawn until a fresh policy arrives. |
| One of the two files is deleted or edited | When the vault is unlocked, it puts them back from the policy it holds. This also works while the server cannot be reached. |

## What happens to the audit records

Audit records keep being written to `~/.zn/audit.jsonl`. While you are offline they wait there. They are uploaded on the next sync that works, in batches of up to 500 records, resuming from the last record that was sent.

## See the state with `zn team status`

`zn team status` reads the saved copy, so it works offline too. After a failed sync it shows the policy you still have, how many records are waiting and why the last sync failed:

```bash
zn team status
```

```text
Organization: Example Org (org_example)
Installation: inst_example via https://api.example.com
Policy:       version 12, valid until 2026-11-13T09:00:00.000Z
Audit upload: 37 records pending
Last sync:    FAILED 2026-11-08T08:30:00.000Z: could not reach the zn server (last success 2026-11-06T09:00:00.000Z); run `zn team sync` to retry
```

If the policy has run out while you are offline, the `Policy:` line ends with `-- EXPIRED: strict mode (only restrictions apply) until zn can reach the server. If this computer is online, check its date and time.`

The automatic sync keeps the reason it failed and writes one audit record, then at most one more every 6 hours while it keeps failing.

## Back online

zn also syncs by itself while the vault is unlocked: a few seconds after `zn unlock`, then every 15 minutes. To do it at once, run `zn team sync` again. On success the first line of the output is `Policy: current (version 12)` (or `updated`, when a newer version came down), and the exit code is `0`.

## Exit codes of `zn team sync`

| Code | Meaning |
| --- | --- |
| `0` | A valid policy is applied and no upload failed. |
| `1` | The machine is offline, the organization has no policy yet, the policy was refused, the machine was removed from the organization, or an upload failed. The command says why; `zn team status` keeps the last reason. |

A sync that was running when you left the organization, or joined another one, is dropped and writes nothing.
