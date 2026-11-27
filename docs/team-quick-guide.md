# zn Team quick guide for a team lead

A one-page summary for the person who sets zn Team up for a small team. It only repeats what [team.md](team.md) and [cli.md](cli.md) already say. Read [team.md](team.md) for the full details.

zn Team lets your organization publish one policy for how developers' AI agents may use secrets, and collect the audit records of that use. zn-gate is a local guardrail, not device management: someone with full control of their own machine can leave the organization or stop zn-gate. The dashboard shows each machine's last policy version and last upload, so a machine that stops reporting is visible.

## Set up the organization (lead)

You do this once, in the dashboard at usezn.com, signed in with the account that will own the organization. Set up two-factor authentication first (**Settings → Security**): inviting people, publishing a policy and creating join tokens ask for a second factor from the last 10 minutes.

1. Create the organization and start the Team trial from the **Team** page.
2. Invite people: **Team → Members → Invite**, with their email address and a role. The invitation link works once, for that address, for 7 days. It adds the person to the organization on the web; it is not what a machine joins with.
3. Create a join token: **Team → Members → Connected installations → New join token**. It starts with `znj_`, is valid for 7 days and works for as many machines as the organization has seats. Send it to each developer in a private message, together with the organization name.
4. Publish a policy: **Team → Policies** (the format is below).
5. Check that machines report in: **Team → Members → Connected installations** shows each machine's zn-gate version, when it was last seen and its audit records.

Every dashboard step is described in [Administer your organization](https://usezn.com/docs/team/admin/).

## What each developer does

Each machine needs zn-gate installed globally (`npm install -g zn-gate`, which puts the short `zn` command on the PATH; with `npx -y zn-gate` only, write `npx -y zn-gate team join -` instead of `zn team join -`) and the vault unlocked (`zn unlock` creates it the first time).

```bash
zn unlock
zn team join -
# paste the join token and press Enter (it stays out of your shell history)
zn team status
```

- The join token (`znj_...`) comes from an organization admin.
- `zn team join` is confirmed on the vault's own channel (the terminal of `zn unlock --foreground`, or a system dialog), not in the terminal where the command ran. An AI agent cannot answer that dialog.
- The dialog shows the organization name, who invited the developer, the server and the last characters of the token. Tell your team to compare them with what you sent, and to choose Deny if they did not start the command.
- `zn team status` shows the organization, policy version and expiry, and the upload state. It never shows the install token.
- The join dialog also lists a short status report: the zn-gate version, the OS family, the policy version and state, and whether each agent's hooks are ok, stale or broken. No paths, no names. `zn team status` shows exactly what was sent last.

## Commands your team will use

| Command | What it does |
|---|---|
| `zn team join <token>` | Connects this machine to your organization. |
| `zn team status` | Shows the organization, policy version and upload state. `--json` for scripts. |
| `zn team sync` | Downloads the policy and uploads pending audit records now. |
| `zn team status-report accept` or `stop` | Only for a machine that joined before the status report existed: it sends nothing until you accept once. `stop` turns it off. |
| `zn team leave` | Disconnects this machine. The organization's policy stops applying here. |

Sync also happens on its own while the vault is unlocked: a few seconds after `zn unlock`, then every 15 minutes. `zn team sync` exits with `1` when the policy is rejected or the machine was removed.

## Write a policy

The policy lists rules by secret **name**, never by value. Each rule has one choice:

| Choice | Field | Effect |
|---|---|---|
| Not blocked (default) | none | The use goes ahead within the rule's other limits. |
| Warn | `"warn": true` | The use goes ahead, the developer and the agent see a notice, and the audit record has the decision `warn`. |
| Block | `"deny": true` | The use is stopped. |

```jsonl
{ "secret": "PROD_*", "agents": ["*"], "deny": true, "reason": "No production credentials in AI agents" }
{ "secret": "STRIPE_KEY", "agents": ["claude-code"], "allowHosts": ["api.stripe.com"] }
{ "secret": "STAGING_*", "agents": ["*"], "warn": true, "reason": "Staging credentials need review" }
```

Things to know:

- A rule cannot have both `deny` and `warn`. If one rule blocks a secret and another warns, the block wins.
- Every rule that matches a secret restricts it for all agents, whatever its `agents` list says.
- The organization can never read secret values, open a new command, mode or HTTP placement for a secret, or change the protections for credential files, `~/.zn` and agent configuration.
- Letting a secret go to a new host needs approval on the developer's machine, once per organization, secret and host.

## Offline and removal

- A policy is valid for 7 days. With no network it keeps applying, and audit records wait in `~/.zn/audit.jsonl` until they can be uploaded.
- After that, strict mode applies: the restrictions stay, and anything the organization had opened is withdrawn until a fresh policy arrives. `zn team status` says so.
- When an admin removes a machine, uploads stop and `zn team status` shows "REMOVED FROM ORG".
- While the vault is locked nothing is downloaded or uploaded, but the last accepted policy still applies.

## Run the hooks on every machine

To make zn-gate's hooks run on every machine, deploy them with your device management tool. `zn team managed-config` prints the files to deploy. It writes nothing and reads nothing from the machine you run it on.

```text
zn team managed-config --agent claude-code --os macos
```

`--managed-hooks-only` and `--exclusive-mcp` are off by default, because they change what developers' own hooks and MCP servers can do. Read the warnings in [team.md](team.md#deploy-zn-gates-hooks-to-every-machine-managed-settings) before turning them on.

## Export the audit log

For the whole organization, owners, admins and auditors export from the dashboard: **Team → Evidence**, as CSV, JSON or OpenTelemetry logs. Every export is recorded in the activity log with its SHA-256; the download also states its row count and whether it was cut short ([Export the audit trail](https://usezn.com/docs/team/export/)). There is no `zn team` command for this.

On one machine, the local vault audit log can be written as OpenTelemetry logs. This needs no account:

```bash
zn vault log export --otlp --since 7d --out zn-audit.otlp.jsonl
```

## More

- [zn Team on a developer machine](team.md): the full page, including what is sent to the server.
- [Command line reference](cli.md): every command, option and exit code.

## Where each step is explained

| Section on this page | Full page |
|---|---|
| Set up the organization (lead) | [Roles in a team](team.md#roles-in-a-team), [Administer your organization](https://usezn.com/docs/team/admin/) |
| What each developer does | [Commands in team.md](team.md#commands), [`team join` in cli.md](cli.md#team-join) |
| Commands your team will use | [Commands in team.md](team.md#commands), [zn Team in cli.md](cli.md#zn-team) |
| Write a policy | [The organization policy in team.md](team.md#the-organization-policy) |
| Offline and removal | [Offline, expiry and removal in team.md](team.md#offline-expiry-and-removal), [Remove zn-gate](uninstall.md) |
| Run the hooks on every machine | [Deploy zn-gate's hooks to every machine](team.md#deploy-zn-gates-hooks-to-every-machine-managed-settings), [`team managed-config` in cli.md](cli.md#team-managed-config) |
| Export the audit log | [Export the audit log to OpenTelemetry](team.md#export-the-audit-log-to-opentelemetry), [`vault log export` in cli.md](cli.md#vault-log-export) |
