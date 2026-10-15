# zn Team on a developer machine

zn Team lets an organization publish one policy for how its developers' AI
agents may use secrets, and collect the audit records of that use. This page
covers the zn-gate side: what runs on each machine, what the organization can
and cannot change there, and what is sent. The vault, markers and the
`secrets` MCP server are described in [secrets.md](secrets.md).

zn-gate is a local guardrail, not device management. Someone with full
control of their own machine can leave the organization or stop zn-gate; the
dashboard shows each machine's last policy version and last upload, so a
machine that stops reporting is visible.

## Commands

| Command | What it does |
|---|---|
| `zn team join <token>` | Connects this machine to your organization. The token (`znj_...`) comes from an organization admin. Needs the vault unlocked (`zn unlock`). |
| `zn team status` | Organization, installation id, policy version and expiry, upload state. `--json` for scripts. Never shows the install token. |
| `zn team sync` | Downloads the policy and uploads pending audit records now. This also happens on its own while the vault is unlocked: a few seconds after `zn unlock`, then every 15 minutes. |
| `zn team leave` | Disconnects this machine. The organization's policy stops applying here. |
| `zn vault log export --otlp` | Writes the local audit log as OpenTelemetry logs (works without zn Team; see below). |

`zn team join` and `zn team leave` are confirmed on the vault's own channel
(the terminal of `zn unlock --foreground`, or a system dialog), not in the
terminal where the command ran. An AI agent can type in that terminal; it
cannot answer the vault's dialog. Before the dialog, zn-gate asks
`api.usezn.com` which organization the token is for, without using up the
token; the dialog then shows the organization name, who invited you (the
display name they chose, if they set one), the server and the last characters
of the join token. Check them against what your admin sent you. If you did not
start the command yourself, choose Deny. If the organization you then join is
not the one the dialog showed, zn-gate refuses it and does not connect this
machine.

An invalid, expired or used-up token stops before the dialog, and so does a
token of an organization without an active Team subscription. With
`--api`, zn-gate does not contact the other server before you confirm, so
the dialog cannot name the organization; it says so, and the name appears
after joining. The same happens if the check fails.

`--api <https URL>` points `zn team join` at another server. The dialog warns
when it is not `api.usezn.com`.

## The organization policy

The policy lists rules for secrets by **name** (for example `PROD_*`), never
by value:

```json
{ "secret": "PROD_*", "agents": ["*"], "deny": true, "reason": "No production credentials in AI agents" }
{ "secret": "STRIPE_KEY", "agents": ["claude-code"], "allowHosts": ["api.stripe.com"] }
{ "secret": "STAGING_*", "agents": ["*"], "warn": true, "reason": "Staging credentials need review" }
```

zn-gate applies a downloaded policy only if:

- its Ed25519 signature verifies with the organization key received at join
  time (the key id must match);
- it is for this organization, it has not expired, and it was not issued in
  the future (five minutes of clock difference are tolerated);
- its version is not lower than the last one accepted on this machine.

The accepted policy is kept inside the encrypted vault. `~/.zn/org-policy.json`
is a readable copy: editing or deleting it does not remove any restriction.

### What the organization can change on this machine

| | |
|---|---|
| **Always** | Block a secret (`deny`). Narrow the hosts (`allowHosts`) or commands (`allowCommands`) a secret may be used with. Force `proxy` mode. Limit where `secrets_http_request` may put the value (`injectAt`). Add custom secret formats for the scrubber (`detectors`). |
| **Only after you approve it on this machine** | Let a secret go to a host your local settings do not allow. The first time an agent needs that host, the vault asks you; the approval is kept per organization, secret and host. A wildcard host (`*.example.com`) is flagged as such in the dialog. |
| **Never** | Open a new command, mode or HTTP placement for a secret. Change or switch off the protections for credential files, `~/.zn` and agent configuration. Read secret values. |

So a stolen organization signing key cannot make zn-gate send a secret
somewhere new without someone at the machine saying yes.

**Restrictions apply to every agent.** zn-gate cannot prove which agent is
calling (any program on the machine can start its tools and say it is some
agent), so every rule that matches a secret restricts it for all agents,
whatever its `agents` list says. A `deny` written for Codex also blocks the
secret in Claude Code. The `agents` list only decides who can be offered a
new host: the `secrets` MCP server started from the configuration zn-gate
writes for that agent (`zn hooks install <agent>` passes `--agent`), or any
agent for `*`. Rules apply in order, and a host list from an earlier rule
is never widened by a later one.

Only `proxy` is applied from a rule's `mode`; other modes in a rule are
ignored.

### Block or warn

A rule with `"deny": true` blocks the secret. A rule with `"warn": true`
lets the use go ahead, and:

- writes an audit record with the decision `warn` (reason `policy:warn`),
  which is uploaded to your organization with the other records;
- shows this line to you and to the agent, with the rule's `reason` quoted
  as a policy note:

  ```
  zn: your team policy would block STAGING_TOKEN here (policy note: "Staging credentials need review"). It was allowed and recorded for your organization.
  ```

`zn run` prints it on the command's error output; the `secrets` MCP server
adds it to the tool result (`notice`) and prints it on its own error output.
This happens wherever a `deny` would have blocked: `zn run`,
`secrets_http_request` and `secrets_render_file`.

The rule's other fields (`allowHosts`, `allowCommands`, `mode`, `injectAt`)
still apply. A rule cannot have both `deny` and `warn`: such a policy is
refused like any other invalid policy. When one rule blocks a secret and
another warns, the block wins. Like every rule, a warning applies to all
agents, whatever its `agents` list says.

zn-gate 1.7 and earlier do not know `warn` and would refuse a whole policy
that uses it. Newer versions say on each policy download that they
understand it (see [What is sent](#what-is-sent)). For older versions the
zn service removes only the `warn` field: the rule and its other
restrictions still apply, but those machines use the secret without
showing the warning and do not record `warn` decisions. Update them to
see and record warnings.

Custom `detectors` run with the built-in patterns and only add redactions.
A pattern runs only if its cost is bounded before it runs: a flat sequence
of characters, escapes and character classes, each with an optional `{n}`
or `{m,n}` (n up to 256). At most one repetition may vary in length (by at
most 64), and (that variation + 1) times the longest possible match must be
at most 4096. No groups, alternatives, `?`, `*` or `+`. For example
`ACME-[A-Z0-9]{24}` or `xox[bp]-[0-9]{10,13}-[A-Za-z0-9]{24}`. Other
patterns are skipped on the machine, and all custom detectors together get
200 ms per scan.

### Offline, expiry and removal

| Situation | What happens |
|---|---|
| No network, policy still valid (policies are valid for 7 days) | The policy keeps applying. Audit records wait in `~/.zn/audit.jsonl` and are uploaded later. |
| No network for longer than the policy's validity | Strict mode: the restrictions keep applying; anything the organization had opened is withdrawn until a fresh policy arrives. `zn team status` says so. |
| A downloaded policy fails a check (signature, key, organization, expiry, older version) | It is refused and the last accepted policy stays. The refusal is recorded in the audit log. |
| An admin removes this machine | Uploads stop. `zn team status` shows "removed from org". The last policy applies until it expires, then strict mode. |
| The vault is locked | Nothing is downloaded or uploaded until `zn unlock`. The last accepted policy still applies to every use of a secret, which needs the vault unlocked anyway. |

## What is sent

- **At join:** the join token, a random installation id, this machine's
  audit key (it lets the server check that uploaded records were not
  altered), the zn-gate version, the OS family and, if given, the agent.
- **Policy download:** the install token, the policy version already held
  and the policy features this zn-gate understands (header
  `X-ZN-Policy-Features: warn`).
- **Audit upload:** the records of `~/.zn/audit.jsonl`, including the ones
  written before joining: time, secret name, mode, agent, tool, command name,
  host, decision and reason, with their sequence number and HMAC chain. Never
  secret values, hashes of values, full command lines, file paths, prompts
  or tool output. Batches of up to 500 records resume from the last record
  the server confirmed.

The install token is kept in the encrypted vault and is sent only to the
server you joined.

## Export the audit log to OpenTelemetry

```bash
zn vault log export --otlp --since 7d --out zn-audit.otlp.jsonl
```

The file holds one OTLP/JSON `ExportLogsServiceRequest` per line (up to 500
records each). The OpenTelemetry Collector reads it with its `otlpjsonfile`
receiver, and each line can be posted as is to an OTLP/HTTP `/v1/logs`
endpoint:

```yaml
receivers:
  otlpjsonfile: { include: ["./zn-audit-*.otlp.jsonl"], start_at: beginning }
exporters:
  debug: { verbosity: detailed }
service:
  pipelines:
    logs: { receivers: [otlpjsonfile], exporters: [debug] }
```

Each record is a `zn.gate.decision` event. `deny`, `warn`, `withhold` and
`ask:no` have severity `WARN`, `error` has `ERROR`, the others `INFO`. The
HMAC chain travels with it (`zn.audit.seq`, `zn.audit.prev`,
`zn.audit.mac`), so a gap or a reordered record stays visible after the
export. The mapping is the same as the export
from the zn dashboard. No account is needed for the local export.
