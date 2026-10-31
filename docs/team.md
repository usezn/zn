# zn Team on a developer machine

| Command | Summary |
|---|---|
| `zn-gate team join` | Connects this machine to your organization with the join token your admin gave you. |
| `zn-gate team status` | Shows the organization, the policy version and the state of the audit upload. |
| `zn-gate team sync` | Downloads the policy and uploads the audit log now. |
| `zn-gate team leave` | Disconnects this machine from the organization. |
| `zn-gate team managed-config` | For administrators. Prints the managed configuration files to deploy so that the zn hooks run for every developer. |

Options and exit codes are in the [command line reference](cli.md#team).

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
| `zn team join <token>` | Connects this machine to your organization. The token (`znj_...`) comes from an organization admin. Needs the vault unlocked (`zn unlock`). The join counts as done only once the organization's first valid policy has been downloaded and applied. If the policy cannot be downloaded, or the organization has not published one yet, the command exits `1`: this machine is registered but `zn team status` shows the join as **pending** until `zn team sync` succeeds. |
| `zn team status` | Organization, installation id, policy version and expiry, what the last policy version removed or loosened, upload state, and the result of the last sync (what failed, and when it last worked). If the server has not yet been told that you left, a "Revocation pending" line with the last error and the next step. `--json` for scripts (`join_pending`, `last_sync`, `policy.change`, `revocation_pending`). Never shows the install token. |
| `zn team sync` | Downloads the policy and uploads pending audit records now. Exits `0` only when a valid policy is applied and no upload failed; offline, no policy, a refused policy, a removed machine or a failed upload exit `1` and say why. This also happens on its own while the vault is unlocked: a few seconds after `zn unlock`, then every 15 minutes. If you leave the organization or join another one while a sync is running, that sync is dropped and writes nothing. |
| `zn team leave` | Disconnects this machine and tells the server (see [Leaving](#leaving)). The organization's policy stops applying here at once. It deletes the local copies of the policy and the upload state one by one; if one cannot be deleted (for example a locked file), the command exits `1` and names the file to delete by hand, because the hooks still read it. |
| `zn team managed-config` | Prints the files an admin deploys with device management so zn-gate's hooks run on every machine. Writes nothing; see [Deploy zn-gate's hooks to every machine](#deploy-zn-gates-hooks-to-every-machine-managed-settings). |
| `zn vault log export --otlp` | Writes the local audit log as OpenTelemetry logs (works without zn Team; see below). |

`zn team join` and `zn team leave` are confirmed on the vault's own channel
(the terminal of `zn unlock --foreground`, or a system dialog), not in the
terminal where the command ran. An AI agent can type in that terminal; it
cannot answer the vault's dialog. First the vault asks whether zn-gate may
send the token to `api.usezn.com` to look up which organization it is for;
nothing is sent before you agree, and the lookup does not use up the token.
Then the dialog shows the organization name, who invited you (the
display name they chose, if they set one), the server and the last characters
of the join token. Check them against what your admin sent you. If you did not
start the command yourself, choose Deny. If the organization you then join is
not the one the dialog showed, zn-gate refuses it and does not connect this
machine.

An invalid, expired or used-up token stops before the second dialog, and so does a
token of an organization without an active Team subscription. With
`--api`, zn-gate does not contact the other server before you confirm, so
the dialog cannot name the organization; it says so, and the name appears
after joining. The same happens if the check fails.

`--api <https URL>` points `zn team join` at another server. The dialog warns
when it is not `api.usezn.com`.

`zn team join` sends only the audit records written **from the moment you join**.
The records already in `~/.zn/audit.jsonl` (secret names, hosts, agents, tools
and decisions from before) stay on your machine. To send them as well, run
`zn team join <token> --include-history`: the dialog then says so in its own
warning, and you can still choose Deny. History can only be added at the first
join of an installation; to add it later, run `zn team leave` and join again
with the flag. A machine that joined with an earlier zn-gate keeps sending
everything, as it was agreed then.

### Leaving

`zn team leave` first asks the server to revoke this installation, using the
installation's own install token (and nothing else: no id, no account), and
only then deletes the local membership. The answer decides what is printed:

- **The server revoked it** (or had already revoked it, or no longer accepts
  the token because an admin removed the installation): the leave is
  complete. The installation shows as left in the organization's activity log
  and its token stops working.
- **The server could not be asked or did not take it** (offline, a server
  error, a rate limit, or an older server without this endpoint): this
  machine still leaves at once. The organization's policy, detectors and
  uploads stop applying here, and the command exits `0` and says clearly that
  the server was **not told yet**. Until a retry works, the installation stays
  on the organization's list of connected installations and its token still
  works on the server.

For that second case zn-gate keeps a small "revocation pending" record in
the encrypted vault: the install token, the organization, the API address and
the time. It is not a membership and gives the organization no control: no
policy, no uploads, no detectors; the token is used for nothing else. It is
retried on `zn team sync`, on `zn team leave` and every 15 minutes while the
vault is unlocked, each time with the token of the installation that left
(also after you join an organization again, when the new membership keeps its
own token and is never affected). The record is removed when the server
confirms (or answers that the token is no longer valid). It is never dropped
because of its age and the warning stays in `zn team status` until the server
has confirmed; an organization admin can also remove the installation from the
dashboard, and zn-gate then clears the record on its next retry. Every pending
installation is kept, up to 64: with 64 unconfirmed leaves, `zn team leave`
refuses to leave another organization and tells you to run `zn team sync` or
ask an admin to remove them. `zn team status` shows each pending record (since
when and the last error); `--json` has it as `revocation_pending`. A server that answers 404 or 405 (an older API) is
treated as "not supported yet", never as revoked. If the server asks to wait
(HTTP 429), zn-gate waits for the time it gave.

## The organization policy

The policy lists rules for secrets by **name** (for example `PROD_*`), never
by value:

```jsonl
{ "secret": "PROD_*", "agents": ["*"], "deny": true, "reason": "No production credentials in AI agents" }
{ "secret": "STRIPE_KEY", "agents": ["claude-code"], "allowHosts": ["api.stripe.com"] }
{ "secret": "STAGING_*", "agents": ["*"], "warn": true, "reason": "Staging credentials need review" }
```

zn-gate applies a downloaded policy only if:

- its Ed25519 signature verifies with the organization key received at join
  time (the key id must match);
- it is for this organization, it has not expired, and it was not issued in
  the future (five minutes of clock difference are tolerated);
- its version is not lower than the last one accepted on this machine, and a
  policy with the same version as the one held has the same content (zn-gate
  keeps a digest of each accepted policy, without its validity dates, and
  refuses a second, different policy signed under the same version). The
  service signs the same version again every day with new dates: that renewal
  is accepted and extends the validity, while an older signature of the same
  version cannot shorten it.

The accepted policy is kept inside the encrypted vault. `~/.zn/org-policy.json`
and `~/.zn/team.json` are readable copies for the hooks and `zn team status`:
editing or deleting them does not remove any restriction, and zn-gate puts
them back from the vault (see
[The readable copies and the hooks](#the-readable-copies-and-the-hooks)).

### What the organization can change on this machine

| | |
|---|---|
| **Always** | Block a secret (`deny`) or warn about its use (`warn`). Narrow the hosts (`allowHosts`) or commands (`allowCommands`) a secret may be used with. Force `proxy` mode. Limit where `secrets_http_request` may put the value (`injectAt`). Add custom secret formats for the scrubber (`detectors`). |
| **Only after you approve it on this machine** | Let a secret go to a host your local settings do not allow. The first time an agent needs that host, the vault asks you; the approval is kept per organization, secret and host. A wildcard host (`*.example.com`) is flagged as such in the dialog. |
| **Never** | Open a new command, mode or HTTP placement for a secret. Change or switch off the protections for credential files, `~/.zn` and agent configuration. Read secret values. |

So a stolen organization signing key cannot make zn-gate send a secret
somewhere new without someone at the machine saying yes.

### When the organization lifts a restriction

A new policy version can also remove or loosen what the previous one
restricted: unblock a secret, turn a block into a warning or drop it, widen a
host, command or placement list, drop `proxy` mode, remove a custom detector.
zn-gate applies it. Who may relax the restrictions on a managed machine is
the organization's decision, and the machine cannot tell a change the
organization meant from one it did not mean, so there is no local minimum
and no local approval for it (an approval that the person at the machine can
give would also let them lift the restrictions the organization wants to
keep). What zn-gate does is make the change visible:

- `zn team status` lists what the last version removed or loosened (up to 20
  items; the rest are counted), also with the vault locked. `--json` has it
  as `policy.change`.
- The audit log gets one record per such version, with the reason
  `org_policy_lifted:v3-v4:n2` (the two versions and the number of
  changes). It is uploaded with the other records.
- With Claude Code, the next hook message that checks a tool output or a
  prompt says once that your organization's policy lifted N restrictions
  and where to look. Other agents do not show this line: use
  `zn team status`.

The comparison covers the rules' secret names and their block, warning,
`proxy`, host, command and placement settings, and the custom detectors. A
restriction that moves to another rule that still covers it is not
reported. If the policy held before did not verify, there is nothing to
compare with and nothing is reported.

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

### The three choices: Not blocked, Warn, Block

The dashboard sets one choice per rule. In the policy file the choice is a
field of the rule:

| Choice | Field | What happens on the machine |
|---|---|---|
| **Not blocked** (default) | none | The use goes ahead within the rule's other limits. Nothing is shown and nothing is recorded as a warning. |
| **Warn** | `"warn": true` | The use goes ahead within the rule's other limits. You and the agent see a notice, and the audit record has the decision `warn`. |
| **Block** | `"deny": true` | The use is stopped. |

A rule cannot have both `deny` and `warn`. For a Warn rule the use goes
ahead, and:

- writes an audit record with the decision `warn` (reason `policy:warn`),
  which is uploaded to your organization with the other records;
- shows this line to you and to the agent, with the rule's `reason` quoted
  as a policy note:

  ```text
  zn: your team policy would block STAGING_TOKEN here (policy note: "Staging credentials need review"). It was allowed and recorded for your organization.
  ```

`zn run` prints it on the command's error output; the `secrets` MCP server
adds it to the tool result (`notice`) and prints it on its own error output.
This happens wherever a `deny` would have blocked: `zn run`,
`secrets_http_request`, `secrets_render_file`, and the agent hooks when
they put a secret's value back in place of its `__ZN_NAME__` marker (a
file the agent writes outside git or in a git-ignored path). There, a
`deny` leaves the marker in the file and the hook says why, and a `warn`
puts the value back and adds the line above to the hook's message. Today
only the Claude Code hooks put values back into files; with other agents
the marker stays in the file.

The rule's other fields (`allowHosts`, `allowCommands`, `mode`, `injectAt`)
still apply. A rule cannot have both `deny` and `warn`: such a policy is
refused like any other invalid policy. When one rule blocks a secret and
another warns, the block wins. Like every rule, a warning applies to all
agents, whatever its `agents` list says.

zn-gate 1.7.x and earlier do not know `warn` and would refuse a whole
policy that uses it. zn-gate 1.8.0 and later say on each policy download
that they understand it (see [What is sent](#what-is-sent)). For older
versions the zn service removes only the `warn` field: the rule and its
other restrictions still apply, but those machines use the secret without
showing the notice and do not record `warn` decisions. Update them to
zn-gate 1.8.0 or later to see and record warnings. The table in
[compat.md](compat.md#zn-team-policy-choices-by-zn-gate-version) lists the
choices per version.

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
| No network, policy still valid (policies are valid for 7 days) | The policy keeps applying. Audit records wait in `~/.zn/audit.jsonl` and are uploaded later. The automatic sync keeps the reason it failed (`zn team status` shows it under "Last sync") and writes one audit record, then at most one more every 6 hours while it keeps failing. |
| No network for longer than the policy's validity | Strict mode: the restrictions keep applying; anything the organization had opened is withdrawn until a fresh policy arrives. `zn team status` says so. |
| A downloaded policy fails a check (signature, key, organization, expiry, older version, same version with other content) | It is refused and the last accepted policy stays. The refusal is recorded in the audit log. |
| An admin removes this machine | Uploads stop. `zn team status` shows "removed from org". The last policy applies until it expires, then strict mode. |
| The vault is locked | Nothing is downloaded or uploaded until `zn unlock`. The last accepted policy still applies to every use of a secret, which needs the vault unlocked anyway. |
| `~/.zn/team.json` or `~/.zn/org-policy.json` is deleted or edited | The vault puts them back (see below). |

### The readable copies and the hooks

The hooks do not open the vault to read the policy. They read
`~/.zn/team.json` and `~/.zn/org-policy.json`, verify the policy again with
the pinned key, and use its custom detectors. If either copy is missing, or
the policy copy does not verify, the vault (when it is unlocked) puts both
back from the policy it holds: on the next `zn team sync` (also when the
server cannot be reached), on `zn team status`, and when a hook asks for the
detectors. In the meantime the hook takes the detectors straight from the
vault, so they stay on. While the vault is locked the hooks have only the
readable copies, and a deleted copy comes back after `zn unlock`. The copies
are put back only for the organization this machine is in now: a sync that
started before you left, or before you joined another organization, cannot
bring back a copy of the old one.

If the vault holds a policy that does not verify (for example the
organization's key changed under it), no custom detector can be applied.
The same happens when the policy copy is missing and the vault is locked or
does not answer within 1.5 seconds: the hook cannot get the detectors from
anywhere. Claude Code then shows `zn: Team detectors not applied` once an
hour, with the command to run (`zn team sync`), instead of leaving the
detectors off without a word.

## What is sent

- **At join:** the join token, a random installation id, this machine's
  audit key (it lets the server check that uploaded records were not
  altered), the zn-gate version, the OS family and, if given, the agent.
- **Policy download:** the install token, the policy version already held
  and the policy features this zn-gate understands (header
  `X-ZN-Policy-Features: warn`).
- **Audit upload:** the records of `~/.zn/audit.jsonl` written since you
  joined (the earlier ones only if you joined with `--include-history`): time, secret name, mode, agent, tool, command name,
  host, decision and reason, with their sequence number and HMAC chain. Never
  secret values, hashes of values, full command lines, file paths, prompts
  or tool output. Batches of up to 500 records resume from the last record
  the server confirmed: zn-gate moves forward only as far as the server's
  answer says it stored, and an answer that does not add up (more records
  than were sent, a position outside the batch) is treated as a failed
  upload.

- **Leaving:** one request to `POST /v1/org/install/leave` with the install
  token and the header `X-ZN-Client: zn-gate/<version>`, no body. If it
  fails, it is repeated as described under [Leaving](#leaving).

The install token is kept in the encrypted vault and is sent only to the
server you joined. After you leave it stays in the vault only while a
revocation is pending.

## Deploy zn-gate's hooks to every machine (managed settings)

An organization can push the agents' hooks to every developer machine with its device management tool (Jamf, Intune, Group Policy, Ansible and the like). Managed hooks sit above the developer's own settings, so a developer cannot switch them off by editing a file in their home folder.

`zn team managed-config` prints the files to deploy. It does not write anything and does not read the machine you run it on: copy each printed file to the path shown with your own tooling.

```text
zn team managed-config --agent claude-code --os macos
zn team managed-config --agent all --os all --json
```

| Option | What it does |
|---|---|
| `--agent claude-code\|cursor\|codex\|all` | Which agent to print for. Default: `all`. |
| `--os macos\|linux\|windows\|all` | Which operating system's path to print. Default: the system you run it on. |
| `--managed-hooks-only` | Also run only managed hooks (Claude Code and Codex). Off by default: see the warning below. |
| `--exclusive-mcp` | Claude Code only: also print a `managed-mcp.json` with zn's `secrets` server. Off by default: see the warning below. |
| `--json` | Machine-readable output (`{"schema": 1, "files": [...]}`), for scripts and for generating your own guide. |

Each machine needs zn-gate installed with the `zn` command on the PATH (`npm install -g zn-gate`). The printed hooks call `zn hook <agent>`, the same command `zn hooks install` writes for a project.

| Agent | File | macOS | Linux | Windows |
|---|---|---|---|---|
| Claude Code | `managed-settings.json` | `/Library/Application Support/ClaudeCode/` | `/etc/claude-code/` | `C:\Program Files\ClaudeCode\` |
| Cursor | `hooks.json` | `/Library/Application Support/Cursor/` | `/etc/cursor/` | `C:\ProgramData\Cursor\` |
| Codex | `requirements.toml` | `/etc/codex/` | `/etc/codex/` | `%ProgramData%\OpenAI\Codex\` |

If one of these files already exists on your machines, merge the printed entries into it instead of replacing it. For Claude Code you can save the printed settings as `managed-settings.d/50-zn.json` in the same folder, which Claude Code merges with `managed-settings.json`.

**Claude Code.** The file holds zn's hooks. With `--managed-hooks-only` it also sets `allowManagedHooksOnly`, which makes Claude Code run only managed hooks: your developers' own hooks, and those of their plugins, stop running. Turn it on only if you accept that, and put into managed settings any hook you still need. zn's `secrets` server is a local program, and Claude Code's `managedMcpServers` setting accepts only remote servers, so it cannot carry it. A `managed-mcp.json` can, but it takes exclusive control of MCP: Claude Code then loads only the servers in that file, and developers cannot add their own. `--exclusive-mcp` prints it for that case, and you must add every server your organization approves before you deploy it.

**Cursor.** The enterprise `hooks.json` has `failClosed` on the file-read and prompt hooks: if the hook crashes, times out or returns nothing, Cursor blocks the read or the prompt instead of letting it through. Cursor's documentation does not describe a way to stop developers from adding hooks of their own, or to deploy zn's `secrets` server, so `--managed-hooks-only` and `--exclusive-mcp` change nothing for Cursor.

**Codex.** `requirements.toml` turns hooks on (`[features] hooks = true`, which also applies when a developer turned hooks off in their own `config.toml`) and lists zn's hooks as managed hooks. With `--managed-hooks-only` it also sets `allow_managed_hooks_only = true`, so Codex skips user, project, session and plugin hooks. On macOS, device management can deliver the same text as a base64 payload (`requirements_toml_base64`) in the `com.openai.codex` preference domain. The `mcp_servers` table of `requirements.toml` is an approved list, so zn does not print an entry for it; if you use that list, add the `secrets` server to it yourself.

The formats come from each vendor's documentation, read on 2026-10-19: [Claude Code managed settings](https://code.claude.com/docs/en/managed-settings) and [managed MCP](https://code.claude.com/docs/en/managed-mcp), [Cursor hooks](https://cursor.com/docs/hooks), and [Codex managed configuration](https://learn.chatgpt.com/docs/enterprise/managed-configuration). Run the command again after you update zn-gate, and check the vendor pages if an agent rejects a file.

After a machine has the policy, `zn hooks install` for that agent warns if a managed policy leaves zn's hooks out.

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
