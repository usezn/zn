# Example: export the vault audit log

A short walk-through of `zn-gate vault log export --otlp`. It writes the local audit log of secret use as OpenTelemetry logs, so you can send it to a collector or keep it as a file. It needs no account and sends nothing anywhere. For the Team context and a collector setup, see the [team page](../team.md#export-the-audit-log-to-opentelemetry); for the other vault commands, see the [CLI page](../cli.md).

The output below comes from real runs against a throwaway vault that had just been unlocked, so its log holds one record. Messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> unlock`); here it is shortened to `zn-gate`.

## Export with the vault unlocked

With the vault unlocked, the vault checks the whole audit log first (every signature and the chain) and exports it only if the check passes.

```bash
npx -y zn-gate unlock
npx -y zn-gate vault log export --otlp --out zn-audit.otlp.jsonl
```

The command prints one line to standard error and exits 0:

```text
Exported 1 records to zn-audit.otlp.jsonl (OTLP/JSON Lines, sha256 25dd6508d5f0983218667d7003bf849d1fcdaffe4b6072de9c171aada8927f30).
```

The sha256 is the hash of the exported text. The same records always give the same bytes, so the same hash.

`--out FILE` writes the file with owner-only permissions (`-rw-------`). It is written to a temporary file and moved into place when complete, so an error leaves no half file. It refuses a symbolic link or a folder as the target: a link would send the audit to wherever it points.

Without `--out`, the export goes to standard output, so you can pipe it:

```bash
npx -y zn-gate vault log export --otlp > zn-audit.otlp.jsonl
```

## Options

| Option | Meaning |
|---|---|
| `--otlp` | Required. Without it the command prints its usage line and exits 2: `usage: zn vault log export --otlp [--since 7d] [--out FILE] [--unverified]`. |
| `--since` | Export only records from that time. Use a duration (a whole number plus `s`, `m`, `h` or `d`, such as `7d`) or a date such as `2026-11-01`. |
| `--out FILE` | Write to a file instead of the screen. |
| `--unverified` | Export even when the vault is locked. See below. |

## What the file holds

The file is JSON Lines: each line is one OTLP/JSON `ExportLogsServiceRequest`, with up to 500 records. The export of the one-record log is a single line:

```text
{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"zn-gate"}}]},"scopeLogs":[{"scope":{"name":"usezn.evidence","version":"1"},"logRecords":[{"timeUnixNano":"1794082662334000000","observedTimeUnixNano":"1794082662334000000","severityNumber":9,"severityText":"INFO","eventName":"zn.gate.decision","body":{"stringValue":"allow"},"attributes":[{"key":"event.name","value":{"stringValue":"zn.gate.decision"}},{"key":"zn.decision","value":{"stringValue":"allow"}},{"key":"zn.decision.reason","value":{"stringValue":"ttl:480m"}},{"key":"zn.secret.mode","value":{"stringValue":"unlock"}},{"key":"zn.audit.version","value":{"intValue":"1"}},{"key":"zn.audit.seq","value":{"intValue":"1"}},{"key":"zn.audit.prev","value":{"stringValue":"0000000000000000000000000000000000000000000000000000000000000000"}},{"key":"zn.audit.mac","value":{"stringValue":"d65ca024881b83086f69ecb59575139bba36741ac733ff0175cdb5a3e56327c1"}}]}]}]}]}
```

Reading it:

- The resource is `service.name` `zn-gate`. Two more attributes, `service.instance.id` and `zn.org.id`, appear only on a machine that joined a zn Team organization.
- Each audit record becomes one log record with the event name `zn.gate.decision`. Here the record is the unlock: `zn.decision` is `allow`, `zn.secret.mode` is `unlock` and the reason is `ttl:480m` (the 8-hour session).
- The severity follows the decision: `deny`, `warn`, `withhold` and `ask:no` are `WARN`, `error` is `ERROR`, the rest are `INFO`.
- Other attributes appear when the record has them: `gen_ai.agent.name` (which agent), `gen_ai.tool.name` (which tool), `process.executable.name` (the command name), `server.address` and `server.port` (the host a request went to), and `zn.secret.name` (the name of the secret).
- `zn.audit.seq`, `zn.audit.prev` and `zn.audit.mac` carry the chain: the number of the record, the signature of the one before it and its own signature. A gap or a reordered record stays visible after the export.

The first record has `zn.audit.prev` set to 64 zeros, because nothing came before it.

### What it never contains

The audit log is metadata only, and so is the export. It has no secret values, no hashes of values, no tool output and no full command lines. Each attribute comes from a fixed list and its value is checked against a strict format; a value that does not match is dropped. A field that would contain a known secret value is replaced with `[redacted]`, and one that fails its format with `[invalid]`.

It does contain names: the name of a secret (such as `STRIPE_API_KEY`), the agent and tool, the command name and the host. Treat the file as private, and check that these names are fine to share before you send it to a service outside your organization.

## Export with the vault locked

A locked vault cannot check the chain, so the export is refused and exits 1:

```text
[zn] Not exported: the vault is locked or unreachable, so the audit log chain cannot be verified. Unlock it (`zn-gate unlock`) and export again, or add --unverified to export a copy that is NOT verified.
```

Unlock the vault and run it again for a verified copy. If you need a copy now, add `--unverified`. The export is then made, exits 0, and prints a warning to standard error:

```text
[zn] Warning: the vault is locked or unreachable, so the audit log chain was NOT verified. Unlock it (`zn-gate unlock`) and export again for a verified copy.
```

Keep an unverified file apart from verified ones: a log that was changed would export just as well.

## When the log did not pass its check

With the vault unlocked, a log that was changed is not exported. To see it, one record of a throwaway log was edited by hand. The export then prints, and exits 1:

```text
[zn] Not exported: the audit log was changed behind the vault (noticed 2026-11-07T20:18:21.065Z): bad mac (record 1). Keep a copy of ~/.zn/audit.jsonl as evidence, look into the change, then run `zn-gate vault verify --acknowledge` in your own terminal.
```

See [`vault verify`](../cli.md#vault-verify) for what to do next.
