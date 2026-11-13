# Turn on the optional cloud check

```bash
npx -y zn-gate connect
```

(or `zn-gate connect` if you installed it with `npm i -g zn-gate`).

zn-gate works fully on your computer, needs no account and sends nothing. This command is optional. It adds one thing: when you or your agent use the `analyze_prompt` tool (or `zn-gate analyze`), the text, with detected secrets hidden first, is also checked by the Galvanize 3 classifier at usezn.com. Hooks, file and secret protection, the shield and every other command stay local and never use it.

## What `zn-gate connect` does

1. It only runs in a terminal you are typing in. If an AI agent started it, it refuses.
2. It tells you what will change and asks you to confirm.
3. It opens <https://usezn.com/connect> in your browser. Create a free account (or log in) and create an analysis-only API key there (the connect page does this for you).
4. Back in the terminal, paste the key at the hidden prompt. Nothing you type is shown, and the key is never taken from the command line or an environment variable.
5. It checks the key once with <https://api.usezn.com>. Only the key is sent, as a request header, to that one address, over a verified TLS connection.
   - It accepts only a key limited to analyzing text. Such a key cannot read your usage, list, create or revoke keys, or use the dashboard, so a leaked copy can do little.
   - A full-access key is refused, with a pointer to the connect page.
   - A key the server rejects, or one that could not be checked (no answer, an error), is refused too.
   - In all of these cases nothing is saved.
6. It saves the key, and prints the last four characters so you can recognise it.

## Where the key is kept

Only in one of these, never in a file:

- **Your system keychain**: the macOS Keychain, the Windows Credential Manager, or the Linux Secret Service (GNOME Keyring, KWallet).
- **The zn vault**, when your system has no keychain and the vault is unlocked (`zn unlock`). The vault encrypts it.

If neither is available (for example Linux without a desktop session), nothing is saved and `zn-gate connect` says so. You can still set `ZN_CLOUD=1` and `ZN_API_KEY` in your shell yourself, as before.

`~/.zn/config.json` records only that you connected, where the key is kept and its last four characters. It never holds the key. The cloud check turns on from this record only when the saved key ends in those four characters, so a record written by hand does nothing. When it is the record that turned the check on, zn-gate uses only the saved key, to <https://api.usezn.com>: `ZN_API_KEY` and `ZN_API_URL` are ignored unless you also set `ZN_CLOUD=1`. If the record exists but the key cannot be read, prompts are checked locally and zn-gate says so once.

The key is never written to a file in plain text, and zn's hooks refuse the direct ways for your agent to read it: commands that ask the system keychain for zn's own entries (`security find-generic-password` and `dump-keychain`, `secret-tool lookup`, `cmdkey /list`, `Get-StoredCredential`, picked by zn's service, account or label), code that loads it through zn's own modules or a keyring library, and anything under `~/.zn`. The `connect` and `disconnect` commands themselves are refused when an agent runs them, and the zn vault's request tool for agents never fills in the saved key. zn also hides the key's format (`zn_` followed by 48 characters) in what the agent sees. Other uses of those tools are not affected.

This is a barrier, not a vault wall: a program running as you can still ask the keychain for the key, as it can for any keychain entry. That is why `connect` only accepts a key limited to analyzing text (a copy can do little with it), and why you can revoke it at <https://usezn.com/api-keys>. A key you give in `ZN_API_KEY` or `--key` can be read from your environment, as before.

A saved key is only ever sent to <https://api.usezn.com>. `--url` and `ZN_API_URL` are ignored for it; use `--key` or `ZN_API_KEY` to send to another URL.

## See and change the state

- `zn-gate status` shows whether a key is connected and where it comes from (`ZN_API_KEY`, `--key`, the keychain or the vault), never the key.
- `zn-gate connect --reconnect` replaces the saved key.
- `zn-gate disconnect` removes the key from this computer and turns the cloud check off. If a key is saved, it then asks whether to also revoke it on usezn.com, so it stops working everywhere; the default is no, and only an explicit yes sends anything (one request to <https://api.usezn.com> with the key, over the same checked connection `connect` uses). The local copy is removed in every case, even if the request fails. If it fails, the command says so and points you to <https://usezn.com/api-keys>, where you can revoke the key yourself. `zn-gate disconnect --revoke` skips the question and `--no-revoke` never revokes and makes no network call. Like `connect`, the command only runs in your own terminal: with no terminal, or from an AI agent, it refuses and changes nothing, so nothing is revoked.
- A key in `--key` or `ZN_API_KEY` is used instead of the saved one. `ZN_LOCAL_ONLY=true` or `--local-only` turns the cloud check off even when connected.

## If something fails

- **It refuses to run**: it only runs in a terminal you type in. Open your own terminal and run it there, not through an AI agent or a script.
- **The key is refused**: use the connect page to create an analysis-only key, then run `zn-gate connect` again.
- **The key could not be checked** (no answer, an error): check your connection and try again.
- **It says nothing was saved because there is no keychain**: unlock the vault with `zn unlock` and run `zn-gate connect` again, or set `ZN_CLOUD=1` and `ZN_API_KEY` in your shell yourself.
- **You want to stop**: run `zn-gate disconnect`.

## Common messages

- **Refuses to run (AI agent or no terminal)**: run `zn-gate connect` or `zn-gate disconnect` in your own terminal.
- **Full-access key refused**: create an analysis-only key on <https://usezn.com/connect>, then run `zn-gate connect` again.
- **Key rejected, or could not be checked**: check your connection and run `zn-gate connect` again. Nothing was saved.
- **Nothing saved, no keychain**: run `zn unlock` and then `zn-gate connect`, or set `ZN_CLOUD=1` and `ZN_API_KEY` in your shell.
- **Saved key cannot be read, prompts checked locally**: run `zn-gate status`, then `zn-gate connect --reconnect` to replace the key.
- **`fallback: true` in a result**: the cloud call failed and the local rules checked the prompt. To see whether the service is down, open the [status page](https://usezn.com/status?utm_source=github&utm_medium=docs&utm_campaign=status). See [What is sent](#what-is-sent).

When a cloud check fails, the result also carries a `cloud_error` text. The Node package returns one of these texts, and what to do:

- **`no API key available (run zn-gate status)`**: the saved key could not be read. Run `zn-gate status`, then `zn-gate connect --reconnect` to replace the key.
- **A refusal that names an environment variable**, such as `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE`: zn-gate will not send the saved key over a connection someone could read. Remove the variable and try again; see section 8 of [troubleshooting](troubleshooting.md#8-will-not-send-the-saved-key-tls-settings).
- **`the saved key is only sent to https://api.usezn.com`**: a saved key is not sent to a custom URL. Drop the custom URL, or pass the key with `--key` or `ZN_API_KEY` instead.
- **`Gateway responded with HTTP <code>: ...`**: with `401` or `403`, the key was not accepted: check it. With any other code, try again later and check the [status page](https://usezn.com/status?utm_source=github&utm_medium=docs&utm_campaign=status).

For the full steps, see [If something fails](#if-something-fails).

## What is sent

The text of `analyze_prompt` and `zn-gate analyze` calls, and, in one other case (tool output, below), a sample of tool output. For prompts: the text, after zn-gate removed the secrets it detects (personal data is not removed on this path, and a secret zn-gate does not recognize is sent with the text), and the key as a request header. Tool-call arguments and tool descriptions are never sent. Tool output is off by default, also if you already ran `zn-gate connect` for prompts. It is sent in one case: when you ran `zn-gate connect` and also turned it on yourself by adding `{"hooks": {"cloudCheckToolOutput": true}}` to your own `~/.zn/config.json`. There is no command for it; you edit that file. Only the key saved by `zn-gate connect` is used, never `ZN_API_KEY`. The setting and the record `zn-gate connect` leaves are read only from the `.zn` folder in the home folder of your operating-system account (the one the system reports for your user, not the `HOME` or `USERPROFILE` variable), and the path stays off when `HOME`, `USERPROFILE` or `ZN_HOME` points zn-gate at another folder. So `HOME`, `USERPROFILE`, `ZN_HOME`, `ZN_CLOUD`, `ZN_API_KEY` and a project's settings cannot turn it on, because a project can set environment variables for the agent. If you keep zn's files elsewhere with `ZN_HOME`, this path stays off. When both are in place, the Claude Code hook sends a sample of at most 16 KiB, counted in bytes of UTF-8 text (the first 12 KiB and the last 4 KiB) of each web fetch, MCP tool or shell command result, after replacing the secrets it detects and any email address, phone number, IBAN, card number or national ID number (Spanish DNI or NIE, US SSN), with [EMAIL], [PHONE], [IBAN], [CARD] or [ID] (IP addresses, names, postal addresses and usernames are not removed), so the service can look for hidden instructions aimed at the agent. A result the local check already flagged is not sent. If the call fails (no connection, a timeout, an error from the service), nothing is blocked or added; if the service answers with a verdict that is neither allow nor block (rule `cloud:unknown-verdict`), the same note is added, and the output is still not blocked or changed. Remove that setting, or set it to `false`, to turn off just this path and keep the prompt check. If the cloud call fails, the prompt is checked by the local rules alone (`fallback: true`); it does not fail closed. One exception: if the service answers but its verdict is neither allow nor block, the text is blocked (rule `cloud:unknown-verdict`), because zn-gate cannot tell what the service meant. `zn-gate status` shows the state at any time. See also [What leaves your machine](../README.md#what-leaves-your-machine).
