# Example: three team choices and what developers see

The three choices a rule in the zn Team policy can make (block, warn, allow
within limits), with one rule for each, copied in meaning from
[Write a policy](../team-quick-guide.md#write-a-policy) in the quick guide
and [The three choices: Not blocked, Warn, Block](../team.md#the-three-choices-not-blocked-warn-block)
in team.md. The dashboard sets one choice per rule; in the policy file the
choice is a field of the rule, and the policy lists rules by secret
**name**, never by value. Every name and host below is made up.

## Example 1: block production secrets for every agent

```jsonl
{ "secret": "EXAMPLE_PROD_KEY", "agents": ["*"], "deny": true, "reason": "No production credentials in AI agents" }
```

What happens: the use is stopped.

What the developer and the agent see: the stop happens wherever a `deny`
would have blocked: `zn run`, `secrets_http_request`, `secrets_render_file`,
and the agent hooks when they put a secret value back in place of its
`__ZN_NAME__` marker (a file the agent writes outside git or in a
git-ignored path). There a `deny` leaves the marker in the file and the hook
says why. Today only the Claude Code hooks put values back into files; with
other agents the marker stays in the file.

What the audit record says: each uploaded record carries the time, secret
name, mode, agent, tool, command name, host, decision and reason, never
secret values. In the [OTLP export](../team.md#export-the-audit-log-to-opentelemetry)
each record is a `zn.gate.decision` event, and `deny` is one of the decision
names, with severity `WARN`.

## Example 2: warn on staging secrets

```jsonl
{ "secret": "EXAMPLE_STAGING_KEY", "agents": ["*"], "warn": true, "reason": "Staging credentials need review" }
```

What happens: the use goes ahead, the developer and the agent see a notice,
and the audit record has the decision `warn`. A warning applies to all
agents, whatever its `agents` list says.

What the developer and the agent see: this line, with the rule's reason quoted
as a policy note:

```text
zn: your team policy would block EXAMPLE_STAGING_KEY here (policy note: "Staging credentials need review"). It was allowed and recorded for your organization.
```

`zn run` prints it on the command's error output. The `secrets` MCP server
adds it to the tool result (`notice`) and prints it on its own error output.
In the hooks a `warn` puts the value back and adds the line to the hook's
message.

What the audit record says: the decision `warn`, with the reason
`policy:warn`, uploaded to the organization with the other records.

A rule cannot have both `deny` and `warn`, and when one rule blocks a secret
and another warns, the block wins. zn-gate 1.7.x and earlier do not know
`warn`, so the zn service leaves the `warn` field out of the policy it sends
them: the rule's other limits still apply, without a notice; the
[compatibility table](../compat.md#zn-team-policy-choices-by-zn-gate-version)
lists the choices per zn-gate version.

## Example 3: let one secret reach one host for one agent

```jsonl
{ "secret": "EXAMPLE_STRIPE_KEY", "agents": ["claude-code"], "allowHosts": ["api.example.com"] }
```

What happens: the rule has no `deny` and no `warn`, so it is the Not blocked
choice (the default): the use goes ahead within the rule's other limits,
here the hosts in `allowHosts`.

What the developer and the agent see: nothing is shown for a use inside the
limits, that is, for a host the developer's local settings already allow and
the rule lists. A host the rule lists but the local settings do not allow is
not usable yet: it is offered to the developer for approval on their machine,
once per organization, secret and host, and only for the agents the rule
names. A host the rule does not list stays blocked, and it cannot be
approved. Two different things are at work here. The rule itself restricts
the secret for every agent: a host it does not list is blocked for all of
them, whatever its `agents` list says. The `agents` list only decides for
which agents a listed host is offered for approval: the `secrets` MCP server
started from the configuration zn-gate writes for that agent
(`zn hooks install <agent>` passes `--agent`), or any agent for `*`. Rules
apply in order, and a host list from an earlier rule is never widened by a
later one.

What the audit record says: a use that goes ahead through
`secrets_http_request` is recorded with the decision `allow` and the reason
`http`, the purpose of the request; the other two ways to use a secret
record the reasons `run` and `render`. It is not recorded as a warning.

## The rules behind these examples

- A rule cannot have both `deny` and `warn`; a policy that has one is
  refused like any other invalid policy.
- Every rule that matches a secret restricts it for all agents, whatever
  its `agents` list says. The `agents` list does not narrow that
  restriction: it only decides for which agents a host the rule lists is
  offered for approval (Example 3).
- The rule's other fields (`allowHosts`, `allowCommands`, `mode`,
  `injectAt`) still apply. Only `proxy` is applied from a rule's `mode`;
  other modes in a rule are ignored.
- The organization can never read secret values, open a new command, mode
  or HTTP placement for a secret, or change the protections for credential
  files, `~/.zn` and agent configuration.
