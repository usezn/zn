# Example: review what a new Team policy version changed

A zn Team organization publishes its policy as numbered versions. When a new version arrives, zn-gate checks its signature and applies it. You are not asked to accept or decline it, because the organization decides the rules on a managed machine. What you can do is read what changed and ask your admin if it looks wrong. This page shows how, with a policy that goes from version 3 to version 4. It uses only what [zn Team](../team.md) describes.

The output below comes from the real `zn team status` command. No server was contacted: the throwaway home folder holds a policy that was signed on the spot with a throwaway key, for a made-up organization (`Example Org`). A real machine gets the same files from `zn team sync`, which this page does not run. The commands are written as `zn`; if `zn` is not on your PATH, write `npx -y zn-gate` in its place.

## 1. The rules of version 3

`--rules` prints the active signed policy in plain words. It reads the copy saved on this machine, checks the signature again with the key pinned when you joined, and makes no network call:

```text
$ zn team status --rules
Organization: Example Org (org_Example12345678)
Installation: inst-0001 via https://team.example.invalid
Policy:       version 3, valid until 2026-11-14T13:19:13.533Z
Rules (verified policy, version 3, signed with key 5b8f446feabb0576, valid until 2026-11-14T13:19:13.533Z):
  1. blocks use of secrets named PROD_* (all agents). Reason: Production keys stay with CI
  2. restricts use of secrets named STRIPE_KEY (all agents); hosts allowed: api.stripe.com. Reason: Stripe only talks to Stripe
  3. blocks use of secrets named STAGING_* (all agents). Reason: Staging keys need review
Audit upload: 0 records pending
Local view only: with --rules the vault and the server were not contacted, so upload counts, last sync and removal status are left out. Run `zn team status` without --rules for those.
```

Keep this output if you want to compare later: save it with `zn team status --rules > rules-v3.txt`.

## 2. Version 4 arrives

The next sync downloads it. `zn team sync` does that now, and it also happens by itself a few seconds after `zn unlock` and every 15 minutes while the vault is unlocked. A new version is applied only if its signature, organization and dates check out and its number is not lower than the last one. A policy that fails a check is refused and the last one stays.

## 3. Ask what changed

```text
$ zn team status
Organization: Example Org (org_Example12345678)
Installation: inst-0001 via https://team.example.invalid
Policy:       version 4, valid until 2026-11-14T13:19:13.763Z
Policy change: version 3 to 4 (2026-11-08T13:19:13.765Z) removed or loosened 2 restrictions:
  - secret STAGING_* is no longer blocked
  - secret STRIPE_KEY may now go to more hosts: *.example.com
Audit upload: 0 records pending
The vault is locked: policy downloads and uploads resume after `zn unlock`.
```

This was run with the vault locked, and the change is still listed. The last line is printed as `npx -y zn-gate@1.15.0 unlock` when `zn` is not on your PATH; it is shown here as `zn unlock`.

`Policy change` lists what the new version removed or loosened compared with the previous one: up to 20 items, and the rest are counted. It does not list rules that became stricter, so also read the full rules.

## 4. Read the new rules

```text
$ zn team status --rules
...
Rules (verified policy, version 4, signed with key 5b8f446feabb0576, valid until 2026-11-14T13:19:13.763Z):
  1. blocks use of secrets named PROD_* (all agents). Reason: Production keys stay with CI
  2. restricts use of secrets named STRIPE_KEY (all agents); hosts allowed: api.stripe.com, *.example.com. Reason: Stripe only talks to Stripe
  3. allows, with a warning and an audit record, use of secrets named STAGING_* (all agents). Reason: Staging keys need review
Policy change: version 3 to 4 (2026-11-08T13:19:13.765Z) removed or loosened 2 restrictions:
  - secret STAGING_* is no longer blocked
  - secret STRIPE_KEY may now go to more hosts: *.example.com
...
```

The first lines (`Organization`, `Installation`, `Policy`) are left out with `...`, and so are the last two lines (`Audit upload` and `Local view only`), which are the same as in step 1. Rule 3 changed from a block to a warning: the use goes ahead, you and the agent see a notice, and an audit record is written. Rule 2 gained a wildcard host.

Compare it with `rules-v3.txt` to spot anything else that moved.

## 5. Read the change in a script

```text
$ zn team status --json
```

The change is in `policy.change`. These are the fields of the real output for this example:

```json
{
  "from": 3,
  "to": 4,
  "at": "2026-11-08T13:19:13.765Z",
  "count": 2,
  "items": [
    { "kind": "block_removed", "secret": "STAGING_*" },
    { "kind": "hosts_widened", "secret": "STRIPE_KEY", "values": ["*.example.com"] }
  ],
  "more": 0
}
```

The command prints this object indented, inside the `policy` object, and shows each item on several lines. Here each item is on one line. `more` counts the items beyond the first 20.

## Other places the change shows up

These are described in [When the organization lifts a restriction](../team.md#when-the-organization-lifts-a-restriction) and are not run on this page:

- The vault audit log gets one record per version that lifted something, with a reason such as `org_policy_lifted:v3-v4:n2` (the two versions and the number of changes). It is uploaded with the other records.
- With Claude Code, the next hook message says once that your organization's policy lifted a number of restrictions and where to look. Other agents do not show this line, so use `zn team status`.

## What to check

- The version number went up by what you expected, and the key id in the `Rules` line is the one from earlier checks.
- Each item under `Policy change` is something your admin meant. A block that became a warning, a wider host list or a removed custom detector all lower the protection on this machine.
- A wildcard host such as `*.example.com` is wider than it looks. A secret can go to a host your local settings do not allow only after you approve it on this machine: the vault asks the first time an agent needs that host. See [What the organization can change on this machine](../team.md#what-the-organization-can-change-on-this-machine).
- If a change looks wrong, there is nothing to decline on the machine. Ask your admin, or leave the organization with `zn team leave`.

## See also

- [zn Team on a developer machine](../team.md)
- [See the rules in force](../team.md#see-the-rules-in-force)
- [`team status`](../cli.md#team-status) in the command line reference
