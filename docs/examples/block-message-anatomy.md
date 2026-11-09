# Block message anatomy

When zn-gate stops an action, your agent shows you a short message. This page takes one real message and explains each part, so you can read the next one without guessing what to do.

The message below comes from the zn-gate hook. It was made with a file named `.env` in a temporary folder. All values in that file are made up.

## The message

The hook sends this text to the agent in the reason field of its response. You usually see it in the agent window:

```text
zn: .env holds plain-text secrets, and secret values never go to the model (rule: secret-file:dotenv). Ask the user to run `npx -y zn-gate@1.15.0 env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use.
```

## The parts

| Part | Text | What it tells you |
|---|---|---|
| Prefix | `zn:` | The message comes from the zn hook, not from the agent. Messages that start with `zn:` or `zn blocked this:` come from zn. |
| Reason | `.env holds plain-text secrets, and secret values never go to the model` | What zn found. The file is a `.env` file and it holds values in plain text. zn stopped the read, so the values did not reach the agent. |
| Rule | `(rule: secret-file:dotenv)` | Which zn rule blocked the read. Quote it if you report a block you think is wrong. |
| Next step | `Ask the user to run npx -y zn-gate@1.15.0 env shadow .env in their terminal` | The command to run yourself. The agent cannot run it for you. The version in it is the zn-gate version that wrote the message. |
| Effect of the step | `it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use.` | What the command does. The file keeps placeholders, and the values go to the local vault. |

The decision log also records the block; see the next section.

## Where the block is logged

zn-gate writes every block to the local evidence log, `evidence.jsonl`, in the .zn folder of your home folder (or in the folder that ZN_HOME names). Each line is one record. Each record stores the hash of the record before it, so a changed line breaks the chain. This is the record for the block above (the id, times and hashes come from that test run):

```json
{
  "id": "ev_mw6q0p9h_9e9d00b3",
  "timestamp": "2026-11-07T18:12:24.677Z",
  "agent_environment": "claude-code",
  "phase": "hook-pre_tool",
  "tool_name": "read",
  "payload_sha256": "71a72bc706129dfbaf0d9c596c93762f9ab827181b6880b30630fd5349d23622",
  "payload_preview": "{\"event\":\"pre_tool\",\"tool\":\"read\",\"kinds\":[]}",
  "verdict": "block",
  "rule": "hook-pre_tool-policy",
  "reason": "blocked by the zn hook policy",
  "confidence": 1,
  "latency_us": 0,
  "engine": "zn-hook",
  "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "record_hash": "47e03dced46807da47aafdbf25f66a9e9ca4eb7b29745260a4ab130642cfb76b"
}
```

The fields mean:

- `id`: the record id. Use it with `zn-gate why <id>` to get the explanation for that record.
- `timestamp`: the UTC time of the block.
- `tool_name`: the tool the agent tried to use. Here it is `read`.
- `verdict`: `block` means the action did not run.
- `rule`: the group of checks that fired. The log stores `hook-pre_tool-policy`, which covers the checks that run before the agent uses a tool. The log does not record which check fired; the first sentence of the message gives the reason in plain words.
- `payload_preview`: a short preview of the tool call, with secrets removed. In this record it shows only the event and the tool, not the file path.
- `prev_hash` and `record_hash`: the hash chain. Run `zn-gate evidence --verify` to check that the chain is intact.

The `zn-gate why` command explains the same record in plain words:

```text
zn blocked this at 2026-11-07T18:12:24.677Z (UTC).
  Record:  ev_mw6q0p9h_9e9d00b3
  What:    a tool call, checked by the zn hook before it ran, tool "read" (agent: claude-code)
  Preview: {"event":"pre_tool","tool":"read","kinds":[]}   (as stored in the log, with secrets already removed)
  Rule:    hook-pre_tool-policy - One of the checks of the zn hooks (before the agent ran a tool)

Why it matters: zn stops an action that could expose secrets, damage the machine, change how zn runs, or leak data. The log does not keep which of these checks fired.

The log does not say which check it was, so no single command can be given. The message your agent received names it; see docs/troubleshooting.md, "Block and warn reasons, by family".
Who decides: Depends on the check: some actions only you may run in your own terminal, and some zn never lets an agent do.

Missing from the log: which check of the hook fired.
```

## What to do

1. If you expected the read, run the command from the message in your own terminal.
2. If you did not expect it, ask your agent why it wanted the file. Do not look for a way around the block.
3. To put the file back later, run the restore command that `env shadow` printed, for example `zn env unshadow .env --backup <name>`.

For more, read [section 6 of the troubleshooting page](../troubleshooting.md#6-your-agent-was-blocked-env-holds-plain-text-secrets), [secrets](../secrets.md) and [the why command](../cli.md#why).
