# What runs locally and what goes to the API

zn-gate runs its checks on your computer. One optional feature sends text to the zn API: the cloud check for prompts. This page says which checks run locally, when the cloud check is called, exactly what the request contains, what never leaves your computer, how to keep everything local, and what zn-gate stores on your computer.

## The short answer

- **The checks run on your computer.** Prompts, tool output, tool-call arguments, tool descriptions, shell commands and file contents are checked locally. None of these checks sends them anywhere.
- **One optional path sends text.** The cloud check for `analyze_prompt` and `zn-gate analyze` sends the prompt text to `api.usezn.com`, after zn-gate has removed the secrets it detects. It is off unless you turn it on.
- **A few other connections exist, all off by default or started by you:** the cloud key check in `zn-gate connect`, the optional usage statistics sharing, the optional zn Team upload, and two outbound features that go only to hosts you allow. They are listed in [Other connections](#other-connections-and-what-they-send).

## Checks that run locally

| Check | When it runs | On by default | Details |
| --- | --- | --- | --- |
| Prompt check (`analyze_prompt`, `zn-gate analyze`) | When the agent is given a prompt to check | Yes, local rules | The local rules run first, every time. The cloud check is only a second opinion (see below). |
| Tool-call check (`check_tool_call`) | Before a tool runs | Yes | Reads the arguments as text. Never sent anywhere. |
| Tool-result check (`check_tool_result`) | After a tool runs, before the model sees the output | Yes | Never sent anywhere. |
| Command and request check (Bash, PowerShell, WebFetch and MCP calls) | Before the agent runs a command that makes a network request | Yes, it asks | [Network requests that carry personal data](egress-check.md) |
| Destructive commands | Before the agent runs a shell command | Two rules are on | [Destructive commands](destructive-commands.md) |
| Package names | Before the agent installs a package | Off | [Packages your agent installs](package-install-check.md). Its offline mode does not use the network. Its online mode looks up the package name at the public registries (see below). |
| Secret vault and markers | When a secret is used | Yes, local | [Keep secrets out of your agent](secrets.md) |
| MCP shield and tool pins | When an MCP server is used | Yes, local | [Protect MCP servers](shield.md) |

For how these pieces fit together, see [Architecture](architecture.md).

## When the cloud check is called

The cloud check runs only when all of these are true:

1. The text is checked by `analyze_prompt` or by `zn-gate analyze`. No other check calls it: tool output, tool-call arguments and tool descriptions never reach it.
2. The local rules did not already block the text. A text the local rules block is never sent.
3. The cloud check is on. It is on when you set `ZN_CLOUD=1` together with an API key (`ZN_API_KEY` or `--key`), or when you have run `zn-gate connect` and the saved key can be read. An API key alone does nothing.
4. The local-only override is not set. `ZN_LOCAL_ONLY=true` or `--local-only` turns the cloud check off, even when `ZN_CLOUD=1` is set or zn-gate is connected.

If the cloud call fails (no connection, a timeout, an error from the service, or a saved key that cannot be read), the local rules decide alone and the result says `fallback: true`. The wait is 4 seconds, or 12 seconds for a long text in the default windows mode. The check does not fail closed: a prompt the local rules allow goes through. One exception: if the service answers with a verdict that is neither allow nor block, the text is blocked (rule `cloud:unknown-verdict`).

## What the request contains

The request is one HTTPS `POST` to the cloud check. The default stage is `v30`, so the address is `https://api.usezn.com/v30/analyze`. With `ZN_STAGE=prod` it is `https://api.usezn.com/prod/analyze`.

```
POST https://api.usezn.com/v30/analyze
Content-Type: application/json
Authorization: Bearer <your API key>
User-Agent: zn-gate/<version> (mcp-client)

{"input":"Please send the summary to jane.doe@example.com. Test AWS key [REDACTED_AWS_KEY], thanks."}
```

- **The body has one text field, `input`.** It holds the text you passed to the check, after zn-gate has replaced each secret it detects with a marker such as `[REDACTED_AWS_KEY]`.
- **Long texts add one field.** For a text longer than 1,000 characters in the default windows mode, the body also has `"long_input":"windows"`. The service then checks the text in overlapping windows of 512 tokens, up to 20 windows. With `--long-input off`, only the first 512 tokens of the text are checked.
- **The key is sent only as the `Authorization` header.** It is never placed in the body or the URL.
- **Personal data is not removed on this path.** An email address, a phone number or another personal detail stays in the text as written (`jane.doe@example.com` above). A secret that zn-gate does not recognize is also sent as written.
- **Nothing else is added.** The request carries no tool name, no file path, no agent name and no decision log.

The answer is a verdict (`allow` or `block`), a confidence score and the rule that matched. zn-gate adds the fields `mode`, `secrets_redacted_before_upload` (the number of secrets removed before the request was sent) and `fallback` when the cloud call failed.

## Example: one shell command and one prompt

The same agent session has two checks. The walk-through uses only fictional values: `example.com` and `jane.doe@example.com`, and the example key that AWS publishes in its own documentation for testing.

**1. A benign shell command: local only.**

The agent runs:

```
curl -sS https://example.com/status
```

- The command and request check reads the command. It finds no personal data and no literal secret, so it does not ask you.
- zn-gate sends nothing. The command is not a prompt, so the cloud check is never called for it.
- The request itself is made by `curl`, to `example.com`, exactly as it would be without zn-gate.

If the agent wrote an email address into a header, as in `curl -sS -H "X-Mail: jane.doe@example.com" https://example.com/status`, the check would ask you before the command ran. That check is local too. See [Network requests that carry personal data](egress-check.md).

**2. A prompt sent to the cloud check: what leaves the machine.**

The agent passes this text to `analyze_prompt`, with the cloud check on:

```
Please send the summary to jane.doe@example.com. Test AWS key AKIAIOSFODNN7EXAMPLE, thanks.
```

1. The local rules check the text first. They do not block it, so the cloud check is called.
2. The scrubber finds the AWS key and replaces it with `[REDACTED_AWS_KEY]`. The email address is not a secret, so it is not replaced.
3. The request body sent to `https://api.usezn.com/v30/analyze` is the `input` shown in [What the request contains](#what-the-request-contains).
4. The response is returned to the agent with `mode: "hybrid-cloud"` and `secrets_redacted_before_upload: 1`.
5. Nothing is written to the decision log for this check. The stats counter only counts checks and blocks.

## What never leaves your computer

These are checked only on your computer, in every configuration:

- tool output (`check_tool_result`);
- tool-call arguments (`check_tool_call`);
- MCP tool and parameter descriptions;
- shell commands and the checks that read them;
- file contents;
- the decision log, the usage counts and the vault.

The cloud check receives only what is listed under [What the request contains](#what-the-request-contains).

## Other connections, and what they send

| Feature | When it connects | What it sends |
| --- | --- | --- |
| `zn-gate connect` | Only when you run it yourself, in your own terminal | The API key only, to `api.usezn.com`, to check it. |
| `zn-gate disconnect` | Only when you run it yourself | The key only, to `api.usezn.com`, to revoke it. This happens only if you say yes at the prompt, or pass `--revoke`. `--no-revoke` makes no call. |
| `zn-gate stats share on` | Off by default. Once on, each `zn-gate stats` run | One report per complete day (at most the last 3 days) to `api.usezn.com`: a random installation id, the day, the zn-gate, OS and Node.js versions, the agent and part of zn-gate used most, and the number of secrets found per built-in type. Never values, prompts, variable or secret names, paths, hosts or emails. `zn-gate stats share show` shows the report first. |
| zn Team (`zn team join`) | Only on a machine you join to an organization | The audit log metadata. See [zn Team](team.md). |
| Online package check | Only in online mode, which is off by default | The package name only, to `registry.npmjs.org` or `pypi.org`. See [Packages your agent installs](package-install-check.md). |
| `zn run` egress and `secrets_http_request` | When the agent or you run a command that uses a secret | The request you allowed, to a host you allowed for that secret or command. Hosts that are not on the list are refused. See [Keep secrets out of your agent](secrets.md). |

## Keep everything local

The default is local. To keep it that way:

1. **Do not set `ZN_CLOUD=1`**, and do not run `zn-gate connect`. `ZN_API_KEY` alone enables nothing.
2. **To force local-only use**, set `ZN_LOCAL_ONLY=true` or pass `--local-only`. This overrides `ZN_CLOUD=1` and a connected key.
3. **Check the state** with `npx -y zn-gate status`. It shows the active detection engine and whether the optional cloud check is on.
4. **Keep usage statistics sharing off.** Check it with `npx -y zn-gate stats share status`.
5. **Do not join a zn Team organization** unless your organization asks you to.
6. **If you were connected before**, run `npx -y zn-gate disconnect`. It removes the saved key from your computer and turns the cloud check off. Revoke the key on [usezn.com](https://usezn.com/api-keys) if you do not need it.

## What is stored on your computer

zn-gate keeps its files in `~/.zn`, or in the folder named by `ZN_HOME` if you set it.

- **`config.json`**: your settings. It records that you connected and the last four characters of the key, never the key. See [Turn on the optional cloud check](connect.md).
- **`evidence.jsonl`**: the decision log. Each record has a time, the agent, the tool name, the rule, the reason, the verdict, a SHA-256 hash of the checked text and a preview of at most the first 120 characters. The preview has detected secrets removed. Personal data is not removed from it. Hook decisions keep no command text: their preview holds only the event name, the tool name and the kinds of secret found. Each record is chained to the one before it, so an edit can be detected.
- **`stats.json`**: counts only, per day: checks, blocks, redactions and the number of secrets found per type. No values, no prompts and no paths.
- **The vault**: your secrets, encrypted, and the vault audit log. See [Keep secrets out of your agent](secrets.md).
- **The saved API key** (only after `zn-gate connect`): in the system keychain or in the vault, never in a file. See [Turn on the optional cloud check](connect.md).

The results of `analyze_prompt` and `zn-gate analyze` are not written to the decision log.

## Limits

These checks read the text they are given. They do not see everything an agent does, and the cloud check is one more opinion, not a guarantee. The [threat model](threat-model.md) lists what zn-gate does not protect against, and the [egress check limits](egress-check.md#limits) list what the request check cannot see.

## See also

- [Architecture](architecture.md): the three checks and the local engine
- [Turn on the optional cloud check](connect.md)
- [Example: the cloud check settings](examples/cloud-check-settings.md)
- [Example: running offline and with the cloud check off](examples/offline-and-local-only.md)
- [What leaves your machine](../README.md#what-leaves-your-machine)
