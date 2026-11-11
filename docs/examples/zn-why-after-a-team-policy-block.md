# Example: a team policy blocks a secret, and what `zn why` shows

On a machine that belongs to a zn Team organization, the admin's policy can block the use of a secret by name. This page shows what you and the agent see when that happens, how to find the rule, and what `zn why` can and cannot tell you about it. The names and values are made up.

The output was printed on a test machine in a temporary home folder. A local test server stood in for the organization and signed the policy, so the join, the policy and the messages are real; only the organization is not. The policy had two rules:

- a **Block** rule for secrets named `PROD_*`, with the reason `No production credentials in AI agents`;
- a **Warn** rule for secrets named `STAGING_*`, with the reason `Staging credentials need review`.

To join an organization, see [the first day of zn Team](team-first-day.md). How the policy works is in [zn Team on a developer machine](../team.md#the-organization-policy).

## 1. What the agent sees

The agent asks `zn run` to start a program with the secret `PROD_DB_URL`:

```bash
zn run --secrets PROD_DB_URL -- printenv PROD_DB_URL
```

zn refuses, and nothing runs. The command exits with code `77`:

```text
zn run: Not allowed: secret PROD_DB_URL is blocked for this agent by your organization policy. Next step: do not use this secret here. If the task needs it, review the organization policy, or, if you are an agent, ask the user.
```

The tools of the secrets MCP server refuse in the same way, with a message that starts with the marker of the secret, such as `__ZN_PROD_DB_URL__ is blocked for this agent by your organization policy.` The block does not depend on which agent asked: a rule that names one agent applies to all of them, because zn cannot prove which agent is calling.

## 2. Find the rule that did it

Run this in your own terminal. The output below leaves out two lines, about the installation and the audit upload:

```bash
zn team status --rules
```

```text
Organization: Fake Org (org_EXAMPLE0000000000)
Policy:       version 1, valid until 2026-11-18T00:00:00.000Z
Rules (verified policy, version 1, signed with key 46b02b07abae42ca, valid until 2026-11-18T00:00:00.000Z):
  1. blocks use of secrets named PROD_* (all agents). Reason: No production credentials in AI agents
  2. allows, with a warning and an audit record, use of secrets named STAGING_* (all agents). Reason: Staging credentials need review
```

The secret name matches rule 1, so that is the rule that blocked it, and the reason is the one your admin wrote. The command reads the policy saved on this machine and checks its signature again; it contacts nobody.

## 3. What `zn why` shows

```bash
zn why
```

```text
zn why: there is no evidence log yet, so no block has been recorded on this computer.
```

This is the answer on a machine that has never blocked anything through a hook or the shield. `zn why` explains the last block in the local decision log, and the decision log holds what the hooks and the shield decided about tool calls, file reads and prompts. A secret that the organization policy refuses is decided by the vault, so it is not in that log. Two things follow:

- `zn why` cannot explain this block. Do not look for it there.
- On a machine where the hooks did block something earlier, `zn why` explains that earlier block, not this one. Check the time on its first line before you act on it.

The vault keeps its own record. `zn secret log` lists the refused use as a `deny` line for `PROD_DB_URL`.

## A Warn rule does not block

The `STAGING_*` rule only warns. The same kind of command goes ahead (after the usual first-use approval of the program), and zn says so on the error output:

```bash
zn run --secrets STAGING_TOKEN -- printenv STAGING_TOKEN
```

```text
zn: your team policy would block STAGING_TOKEN here (policy note: "Staging credentials need review"). It was allowed and recorded for your organization.
__ZN_STAGING_TOKEN__
```

The program printed the marker, not the value, as usual with `run`. The use is recorded in the vault log with the decision `warn`, and `zn why` has nothing to show for it either.

## What to do

1. Do not try another way to read the value. The rule is the organization's decision.
2. Tell your admin the secret name and the rule from `zn team status --rules`, and why the task needs it.
3. If the admin changes the choice for that rule (Not blocked, Warn or Block, see [the three choices](../team.md#the-three-choices-not-blocked-warn-block)), pull the new policy with `zn team sync` and run `zn team status --rules` again. See [pull a new team policy](team-sync-after-policy-change.md).

## Project rules are a different thing

A file named `.znrules` or `zn.config.json` in a project can also hold rules that your team shares. Those are not organization policy. They apply to calls through the shield and to the guard in code, and a block by one of them is in the decision log, so `zn why` explains it. See [where custom rules apply](../../packages/zn-gate/README.md#where-custom-rules-apply).

## See also

- [Reading `zn why` after a blocked command](why-blocked-walkthrough.md): a block that is in the decision log.
- [Why was this blocked?](../why-was-this-blocked.md)
- [zn Team on a developer machine](../team.md)
- [Command line reference](../cli.md#why)
- [All examples](README.md)
