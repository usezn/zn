# Why was this blocked?

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

## Where to look when `zn why` shows nothing

`zn why` reads one file, the local evidence log, and explains the last block in it. When it has nothing to explain, it prints one line on the error output and exits with `1`. The text below is what the command prints (the lines start with `zn why: `). Where this section says `zn`, use `npx -y zn-gate` if zn is not on your `PATH`; the command then prints that form too.

| What you see | What it means | What to do |
|---|---|---|
| `there is no evidence log yet, so no block has been recorded on this computer.` (exit `1`) | The log file is not in the folder zn reads (see below). Either no block has happened yet, or the hook wrote to another folder. | Check the folder below. Run `zn-gate check` to see whether the hooks of your agent are set up. |
| `the evidence log is empty, so there is nothing to explain.` (exit `1`) | The file exists but has no lines. | Nothing to do unless you expected a block. Check the folder below. |
| `no block is recorded in the evidence log, so there is nothing to explain.` (exit `1`) | The log has records, but none is a block. | This is the normal state when nothing was blocked. The log writes a record for a denied call and for a tool result from which secrets were removed. An allowed call is not written by the hook (`lib/hooks/runner.js:1908`). |
| the same message, with `N line(s) of the log could not be read, and it may be among them` added | Some lines of the file are not valid records, so the block may be one of them. | Run `zn-gate evidence --verify`, which checks the SHA-256 chain. |
| `no record with the id "<id>" in the evidence log.` (exit `1`) | The id is not in this log: a typo, or a record from another folder. | Copy the `id` from `zn-gate evidence --export` in the same folder. |
| `the evidence log cannot be read (<code>). Nothing was changed.` (exit `1`) | The file or the folder cannot be read, for example because it is a folder, or its permissions do not allow it (`<code>` is the system code, such as `EISDIR` or `EACCES`). | Check that the path below is a file you own and can read. |
| `zn why: unknown option "<option>". usage: ...` (exit `2`) | The command was used wrongly. `zn why` takes only an optional id. | Run `zn why` or `zn why <id>`. |

Two cases are not errors. They exit with `0` and print a block that zn cannot fully explain:

- `Rule: not recorded. This record has no rule id, so zn cannot say which rule fired.` The record has no rule id, so zn does not guess. It says `The log does not hold enough to explain this record.` and points to `zn-gate evidence --export`, which shows everything the record stores (`lib/why.js:91-94`).
- `Rule: <id> (zn has no plain-words explanation for this id)`. The id is not one this version knows. It may come from a newer or older zn-gate, or from a custom setup. Update zn-gate and run `zn why` again (`lib/why.js:97-101`).

### Where the log lives

- The file is `evidence.jsonl`, in the folder named by `ZN_HOME` when that variable is set, and in `.zn` in your home folder otherwise (`lib/evidence.js:9-11`, `lib/stats.js:24-27`).
- `zn why` reads the folder of the environment it runs in (`lib/why.js:156`). If you set `ZN_HOME` for your agent, set it the same way in the terminal where you run `zn why`. Otherwise the command reads a different, empty folder and prints the first message in the table.
- If the log is damaged, zn moves it aside to `evidence.damaged.jsonl` and starts a new one, which is the step that `zn-gate evidence --verify` leads to (`lib/evidence.js:267-270`). Do not move the file yourself before you have read what `--verify` says.
- `zn why` is in the npm package only. The Python package does not have it (see the stats section of [the CLI reference](../cli.md)).

To see what the log holds, run `zn-gate evidence` (the counts and the last 20 records) or `zn-gate evidence --export` (every record). These commands only read the log.

## Still stuck?

- The [troubleshooting guide](troubleshooting.md) lists the messages people meet first, and the [block and warn reasons](troubleshooting.md#block-and-warn-reasons-by-family) explain the rest.
- Do not reword the request to get past a block. If a block looks wrong, report it with the exact message and your `zn-gate --version` at [GitHub issues](https://github.com/usezn/zn/issues). Leave out any secret.
