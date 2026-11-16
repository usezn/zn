# Examples: pull a new team policy with `zn team sync`

Your organization's lead publishes a new version of the team policy, and this page shows how a developer machine picks it up: run `zn team sync`, then read what changed with `zn team status`. All dates, versions and counts below are made up. The full description of zn Team is in [zn Team](../team.md); every option and exit code is in the [command line reference](../cli.md#team).

## What zn-gate accepts

zn-gate applies a downloaded policy only if its signature verifies with the key received when the machine joined, it is for this organization, it has not expired, and its version is not lower than the last one accepted on this machine. A policy is valid for 7 days. The sync also runs by itself while the vault is unlocked: a few seconds after `zn unlock`, then every 15 minutes.

## Pull it now

```bash
zn team sync
```

```text
Policy: updated (version 13)
Audit upload: ok, 12 sent, 0 pending
```

`updated (version 13)` means a new version came down and was applied. When the machine already has the newest version, the line reads `Policy: current (version 12)`. The second line is the audit upload: how many records were sent now and how many are still waiting. The exit code is `0` only when a valid policy is applied and no upload failed.

The vault must be unlocked for a sync. While it is locked, nothing is downloaded or uploaded.

## Read the result

`zn team status` shows the organization, the installation, the policy in force, what the last version removed or loosened, the upload state and the result of the last sync. After the sync above:

```bash
zn team status
```

```text
Organization: Example Org (org_example)
Installation: inst_example via https://api.example.com
Policy:       version 13, valid until 2026-11-15T09:00:00.000Z
Policy change: version 12 to 13 (2026-11-08T10:05:00.000Z) removed or loosened 2 restrictions:
  - secret STAGING_TOKEN no longer warns
  - secret PROD_TOKEN may now go to more hosts: api.example.com
Audit upload: 0 records pending, last upload 2026-11-08T10:05:00.000Z (ok)
Last sync:    ok, 2026-11-08T10:05:00.000Z
```

Line by line:

- `Organization` and `Installation`: who this machine belongs to, and the installation id and server. The install token is never shown.
- `Policy`: the version now in force and when it stops being valid.
- `Policy change`: what the last version removed or loosened, in plain words — here, one secret is no longer warned about and another may now reach one more host. The line is absent when the last version changed nothing.
- `Audit upload`: how many audit records still wait to be uploaded, and when the last upload was and how it ended.
- `Last sync`: when the last sync ran and how it ended. After a failure it says what failed, when it last worked, and the command to retry.

## When the new version lifts restrictions

A new version can also remove or loosen what the previous one restricted, and zn-gate applies it: who may relax the restrictions on a managed machine is the organization's decision. What zn-gate does is make the change visible:

- `zn team status` lists it under `Policy change` (up to 20 items; the rest are counted). With `--json`, the same information is under `policy.change`.
- The vault audit log gets one record for the version, with the reason `org_policy_lifted:v12-v13:n2` (the two versions and the number of changes), uploaded with the other records.
- With Claude Code, the next hook message that checks a tool output or a prompt says it once:

```text
zn: your organization changed its policy (version 13) and removed or loosened 2 restrictions on this machine. See which with: zn team status.
```

Other agents do not show this line: run `zn team status`.

## See the rules in force

To read the policy your organization signed, run [`zn team status --rules`](../team.md#see-the-rules-in-force). It prints the version, the key id it was signed with, when it stops being valid, and each rule. It reads the copy that `zn team sync` saved on this machine and checks its signature again: it makes no network call, does not open the vault and never shows a secret value. If that copy does not verify or has expired, it prints no rules from it.

## When the sync does not succeed

`zn team sync` exits `1` when the machine is offline, the organization has no policy yet, the policy was refused, the machine was removed from the organization, or an upload failed. The command says why in plain words, and `zn team status` keeps the reason under `Last sync`. A policy that fails a check is refused and the last accepted policy stays in force.
