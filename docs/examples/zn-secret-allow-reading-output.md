# Example: reading the output of `secret allow`

`zn-gate secret allow` changes where an existing secret may be used: it adds hosts or programs to the secret, or changes how it is filled in. This page goes through what the command prints, line by line, and what each refusal means. The name, the host and the program here are made up. For the full picture, read [Keep secrets out of your coding agent](../secrets.md#4-let-a-command-use-a-secret); for the options, see [`secret allow`](../cli.md#secret-allow) in the command reference.

The command changes the policy of a secret, so a person has to run it in a terminal window and confirm it. An agent cannot do it. That also means this page cannot show a full run: the lines below marked "from the code" are the strings `zn-gate` prints, and the refusals marked "a real run" were run in a throwaway home folder with no terminal attached.

## The command

Say `EXAMPLE_API_KEY` was stored with `npx -y zn-gate secret set EXAMPLE_API_KEY` and nothing else, and you now want one program to read it:

```bash
npx -y zn-gate secret allow EXAMPLE_API_KEY --command printenv
```

At least one of `--host`, `--command`, `--in` or `--mode` is needed. Values you pass are added to what the secret already allows. `--replace` swaps the lists instead.

## What it prints when it works (from the code)

```text
Confirm the change in the zn vault prompt (system dialog or the `zn unlock --foreground` terminal).
EXAMPLE_API_KEY: mode=env hosts=- commands=printenv http=header
```

- **First line.** The change is not made yet. zn asks the vault to apply it, and the vault asks you to confirm in its own dialog, or in the terminal where you ran `zn unlock --foreground`. The agent cannot answer that prompt. If you do not confirm, the change is not made.
- **Second line.** The secret as it is after the change, in the form `NAME: mode=... hosts=... commands=... http=...`.
  - `mode`: how the secret is filled in. It is `proxy`, `env` or `file`. If you pass `--command` for a secret that is not in `env` mode and pass no `--host`, zn switches it to `env`, which is why the line says `mode=env`. `--mode` sets it directly.
  - `hosts`: the hosts that `secrets_http_request` may send the secret to. `-` means none.
  - `commands`: the programs that `zn run` may give the secret to. `-` means none.
  - `http`: where in an HTTP request the value may go. `header` is always there. `query` (the URL) and `body` are added only with `--in`.

The command exits with `0`. The value of the secret is never printed.

## Warnings before the confirmation line (from the code)

A warning is printed before the confirm line, so you see it before you approve.

- **A program that runs any code.** For `--command node` (or `python`, `npm` and other interpreters) zn prints that the program "runs any code it is given, so every script it runs could read" the secret, and suggests the specific program instead (`psql`, `terraform`, `gh`).
- **A program your own account can replace.** If the file the program resolves to can be written by your user, zn prints which file, and says that any program you run, an agent too, could replace it. zn checks the file before each use and asks again if it changed. Tools installed with nvm, volta, pipx or Homebrew are normally in this case.
- **`--in query` or `--in body`.** zn prints that an injected prompt could make it send the secret somewhere readable on an allowed host (a gist, an issue), and says to allow it only if the API needs it.

## Check the result

```bash
npx -y zn-gate secret list
```

It lists names and policy, never values. For the secret above, the line has the name, the mode, then `commands=printenv`, and `last used ...` once the secret has been used. The vault must be unlocked first (`npx -y zn-gate unlock`). `secret list` does not show the `http` part; `secret allow` does.

## When it refuses (a real run)

These were run with the same command that `npx -y zn-gate` starts, in a throwaway home folder and with no terminal attached. The exit codes are described in [Exit codes](../exit-codes.md#secrets-and-the-vault).

| What you ran | What zn printed | Exit code |
|---|---|---|
| `secret allow EXAMPLE_API_KEY` (no option) | `zn secret: usage: zn secret allow NAME [--host H] [--command C] [--in header\|query\|body] [--mode proxy\|env\|file] [--replace]` | `64` |
| `secret allow bad-name --host api.example.com` | `zn secret: invalid name: secret names use upper-case letters, digits and single underscores (e.g. GITHUB_TOKEN)` | `64` |
| `secret allow EXAMPLE_API_KEY --in cookie --host api.example.com` | `zn secret: --in must be header, query (the URL) or body` | `64` |
| `secret allow EXAMPLE_API_KEY --host api.example.com` with no terminal | `zn secret: Not allowed: zn secret allow needs an interactive terminal. Open a terminal window yourself and run it there.` | `77` |

The checks run in that order: the name and the options first, then the terminal check. So a typo in an option is reported even when you are not at a terminal.

More refusals, from the code:

- When an AI agent is detected, the terminal check says `zn secret allow must be run by you in your own terminal, not by an AI agent`, followed by a note about what was detected. Open your own terminal and run it there.
- When the name is not in the vault, the command stops with `EXAMPLE_API_KEY is not in the vault`. Store it first with `secret set`. The vault has to be unlocked for this check.
- A `--mode` other than `proxy`, `env` or `file` stops with `--mode must be proxy, env or file`.

## Undo it

There is no command that removes one host or one program. Pick the way that fits:

- Replace a list: `npx -y zn-gate secret allow EXAMPLE_API_KEY --command psql --replace` makes `psql` the only allowed program. A list you do not name is left as it is, and a list cannot be emptied this way.
- Start over: `npx -y zn-gate secret rm EXAMPLE_API_KEY` (it asks you to confirm), then store the secret again with `secret set`. Removing a secret also removes the first-use approvals it had.

Changing the policy is confirmed the same way each time, so you can always see what you are approving.

More worked examples: [Examples](README.md).
