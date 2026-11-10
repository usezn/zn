# Why was this blocked?

## Quick answers

| Exit code | What it means |
|---|---|
| `0` | `zn why` explained the last block. For `hook`, the action was allowed. |
| `1` | `zn why` has nothing to explain: no evidence log yet, no block recorded, or no record with that id. For `hook`, the agent name is unknown. |
| `2` | A hook blocked the action, or `zn why` got an option it does not know. |

The full list of codes is in [exit codes](exit-codes.md).

zn-gate stops some actions before they run. When it does, it prints a message, either to your AI agent or to your terminal. This page covers five of those messages. For each one it shows the message as zn-gate prints it, what caused it, and how to go on safely.

Each block is safe to meet. In the first three cases and the last one, the command did not run or the file was not read, so nothing reached the AI model or changed on your computer. In case 4, the request is held until you decide. If you approve it, the data does leave your computer.

We chose these five because each one covers a different kind of protection, and each has its own entry in the [troubleshooting guide](troubleshooting.md), the [destructive commands](destructive-commands.md) guide or the [network check](egress-check.md) guide. zn-gate does not collect usage counts, so this page does not say how often each block happens.

A part in angle brackets, such as `<file>`, is a blank that zn-gate fills in. Run every command in your own terminal, not through your AI agent. If you installed zn-gate with `npx`, use `npx -y zn-gate` wherever this page says `zn`.

## 1. `.env` holds plain-text secrets

```text
zn: .env holds plain-text secrets. Ask the user to run `zn env shadow .env` in their terminal: it moves the values to the local vault and leaves __ZN_<NAME>__ markers you can read and use.
```

**Why it fired:** your agent tried to read a `.env` file that still has real values written in it. zn-gate stopped the read, so those values never reached the model.

**How to go on safely:**

1. In your own terminal, run `zn env shadow .env`. The values move into the local vault, and the file keeps placeholders such as `__ZN_API_KEY__`.
2. Ask your agent to use the placeholders. The file keeps them in place of the values, so the agent can still work with the file.
3. To put the old file back, run the restore command that `zn env shadow` printed, for example `zn env unshadow .env --backup <name>`.

More in [section 6 of the troubleshooting guide](troubleshooting.md#6-your-agent-was-blocked-env-holds-plain-text-secrets) and in [secrets](secrets.md).

## 2. A file was not read because it holds secrets

```text
zn: ~/.aws/credentials was not read because zn treats it as holding secrets (AWS credentials file), and secret values never go to the model. If a command needs a value, ask the user to run `zn secret set NAME`, then run the command with `zn run --secrets NAME -- <command>` so the program gets it as an environment variable.
```

The first part is the path your agent asked for. The kind in parentheses says what the file is. Other kinds include an SSH private key, a key store, `~/.npmrc` and `~/.pypirc` (package registry tokens).

**Why it fired:** the file usually holds a password or a key, and zn-gate does not let an agent read it.

**How to go on safely:**

1. If a command needs a value from that file, store the value yourself with `zn secret set NAME` in your own terminal.
2. Ask your agent to run the command with `zn run --secrets NAME -- <command>`. The program then gets the value as an environment variable, and the agent never sees it.
3. If you did not expect the read, ask your agent why it wanted that file.

More in [keeping secrets out of your agent](secrets.md) and [the troubleshooting guide](troubleshooting.md#zn-file-was-not-read-because-zn-treats-it-as-holding-secrets-kind).

## 3. A command was blocked as destructive

```text
zn blocked this: it deletes the home folder, the filesystem root or a system folder, recursively. Ask the user to confirm before running this command. If they want it, they can run it in their own terminal; do not run it yourself.
```

The reason after "zn blocked this:" names the kind of damage the command could do. The full list of reasons is in [destructive commands](destructive-commands.md).

**Why it fired:** the command matches a pattern that can wipe files, damage a disk, or change system settings across a whole machine.

**How to go on safely:**

1. If you meant the command, check its exact target first, then run it yourself in your own terminal. zn-gate does not run it for your agent.
2. If you did not mean it, ask your agent for a narrower command that names only the one folder or file it needs to change.
3. Do not reword the command to get past the block. Ask the agent to stop and tell you what it was trying to do.

More in [the troubleshooting guide](troubleshooting.md#a-command-that-wipes-or-damages-the-machine).

## 4. A request would send personal data or a secret away

```text
zn: this command would send `<kind>` to `<host>`. Approve it only if that data should leave this computer.
```

`<kind>` is the type of data, such as an email address or a card number. `<host>` is the server that would receive it. zn-gate never prints the value itself.

**Why it fired:** a `curl`, `wget`, web fetch or tool call holds personal data, or a literal secret, and is headed for a server outside your computer. By default zn-gate asks you before it goes ahead.

**How to go on safely:**

1. Approve the request only if that server should get the data. Otherwise, decline.
2. If the request does not need the data, ask your agent to send it again without that part.
3. If the request needs a secret, do not put its value in the request. For a web request, ask your agent to use the `secrets_http_request` tool of the zn secrets MCP server, which uses the secret in proxy mode. For a program, use `zn run --secrets NAME -- <program>`, so the program reads the secret from its own environment variable.

More in [network requests that carry personal data](egress-check.md).

## 5. The command is too long to check

```text
zn: this command is too long for zn to check (over 100 KB), so it was blocked. Next step: tell the user; do not resend it in parts.
```

**Why it fired:** zn-gate checks every command in full before it runs. A command over 100 KB cannot be checked in time, so zn-gate refuses it rather than let part of it through unchecked.

**How to go on safely:**

1. Ask your agent to break the work into smaller steps, with each command doing one clear job.
2. Do not send the same content again in pieces to get around the limit. That is the case the message warns about.
3. If the job really needs that much text in one command, ask the person who runs the agent to run it in their own terminal, the same as for any command that is left to them.

More in [the troubleshooting guide](troubleshooting.md#a-command-patch-or-output-was-too-big-or-too-complicated-to-check).

## Still stuck?

- The [troubleshooting guide](troubleshooting.md) lists the messages people meet first, and the [block and warn reasons](troubleshooting.md#block-and-warn-reasons-by-family) explain the rest.
- Do not reword the request to get past a block. If a block looks wrong, report it with the exact message and your `zn-gate --version` at [GitHub issues](https://github.com/usezn/zn/issues). Leave out any secret.
