# zn Team quick guide for a team lead

A one-page summary for the person who sets zn Team up for a small team. It only repeats what [team.md](team.md) and [cli.md](cli.md) already say. Read [team.md](team.md) for the full details.

zn Team lets your organization publish one policy for how developers' AI agents may use secrets, and collect the audit records of that use. zn-gate is a local guardrail, not device management: someone with full control of their own machine can leave the organization or stop zn-gate. The dashboard shows each machine's last policy version and last upload, so a machine that stops reporting is visible.

## What each developer does

Each machine needs zn-gate installed and the vault unlocked.

```bash
zn unlock
JOIN_TOKEN='paste-your-join-token-here'
zn team join "$JOIN_TOKEN"
zn team status
```

- The join token (`znj_...`) comes from an organization admin.
- `zn team join` is confirmed on the vault's own channel (the terminal of `zn unlock --foreground`, or a system dialog), not in the terminal where the command ran. An AI agent cannot answer that dialog.
- The dialog shows the organization name, who invited the developer, the server and the last characters of the token. Tell your team to compare them with what you sent, and to choose Deny if they did not start the command.
- `zn team status` shows the organization, policy version and expiry, and the upload state. It never shows the install token.

## Commands your team will use

| Command | What it does |
|---|---|
| `zn team join <token>` | Connects this machine to your organization. |
| `zn team status` | Shows the organization, policy version and upload state. `--json` for scripts. |
| `zn team sync` | Downloads the policy and uploads pending audit records now. |
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
- When an admin removes a machine, uploads stop and `zn team status` shows "removed from org".
- While the vault is locked nothing is downloaded or uploaded, but the last accepted policy still applies.

## Run the hooks on every machine

To make zn-gate's hooks run on every machine, deploy them with your device management tool. `zn team managed-config` prints the files to deploy. It writes nothing and reads nothing from the machine you run it on.

```text
zn team managed-config --agent claude-code --os macos
```

`--managed-hooks-only` and `--exclusive-mcp` are off by default, because they change what developers' own hooks and MCP servers can do. Read the warnings in [team.md](team.md#deploy-zn-gates-hooks-to-every-machine-managed-settings) before turning them on.

## Export the audit log

```bash
zn vault log export --otlp --since 7d --out zn-audit.otlp.jsonl
```

This writes the local audit log as OpenTelemetry logs. It needs no account.

## More

- [zn Team on a developer machine](team.md): the full page, including what is sent to the server.
- [Command line reference](cli.md): every command, option and exit code.
