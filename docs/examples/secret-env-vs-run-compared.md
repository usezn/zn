# Example: `env shadow` and `run` compared

`zn env shadow` and `zn run` both keep a secret value away from your coding agent, but they do different jobs. This page puts them side by side and runs both on one small `.env` file, so you can see when to use which. All values are made up, and the output below comes from real runs in a throwaway home folder.

There is no `zn secret run` command: running a command with a secret is `zn run`, at the top level. The commands are written as `zn`; if `zn` is not on your PATH, write `npx -y zn-gate` in its place.

## The short version

| | `zn env shadow` | `zn run` |
|---|---|---|
| What it is for | A `.env` file that holds real values on disk | Starting a program that needs a value |
| What it changes | The file: values are replaced by `__ZN_NAME__` markers and moved into the vault | Nothing on disk. The value goes only into the environment of that one process |
| How often | Once per file (`env unshadow` undoes it) | Every time the program starts |
| What the agent sees | Markers where the values were | The command's output, with the value masked |
| Needs the vault unlocked | Yes | Yes |
| Needs your approval | No prompt for the move itself. `env unshadow` asks | A command must be allowed for the secret, and its first use is confirmed in the vault prompt |
| Refused inside an agent | Yes, exit code 77 | Not allowed commands are refused, exit code 77 |

They work together: `env shadow` takes the real values out of the file, and `run` puts them back, for one process, when a program needs them.

Run `env shadow` in your own terminal, not through your agent. The command refuses to run without an interactive terminal:

```text
$ zn env shadow .env < /dev/null
zn env: Not allowed: zn env shadow needs an interactive terminal. Open a terminal window yourself and run it there.
```

The exit code of that run is `77`.

## 1. The starting file

```text
EXAMPLE_API_KEY=sk_test_example_0123456789
EXAMPLE_WEBHOOK_SECRET=FAKE_TOKEN_1234567890
PORT=3000
```

Unlock the vault first with `zn unlock`. In this example it runs as `zn unlock --foreground`, so the confirmation prompts below appear in that terminal. Without `--foreground` they appear in a system dialog.

## 2. `env shadow`: take the values out of the file

`--dry-run` lists what would move and changes nothing:

```text
$ zn env shadow .env --dry-run
  EXAMPLE_API_KEY -> __ZN_EXAMPLE_API_KEY__
  EXAMPLE_WEBHOOK_SECRET -> __ZN_EXAMPLE_WEBHOOK_SECRET__
```

`PORT=3000` is not listed: it is not a secret. Now the real run:

```text
$ zn env shadow .env
Shadowed 2 value(s) in .env. The file now holds only markers; the values are in the local vault.
Encrypted copy of the original: ENVBAK_X91D750C8D202611081314 (restore with: zn env unshadow .env --backup ENVBAK_X91D750C8D202611081314)
Next: allow the commands that need them, e.g. zn secret allow EXAMPLE_API_KEY --command "npm run dev"
Run your app with the real values: zn run --secrets EXAMPLE_API_KEY,EXAMPLE_WEBHOOK_SECRET -- <command>
```

The file now reads:

```text
EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__
EXAMPLE_WEBHOOK_SECRET=__ZN_EXAMPLE_WEBHOOK_SECRET__
PORT=3000
```

Write down the name of the encrypted copy (`ENVBAK_...`): step 6 needs it. The last two lines of the output already point at `zn run`.

## 3. `run`: a command that is not allowed yet is refused

The program here is `printenv`, which prints one variable. A secret works only for commands you allowed:

```text
$ zn run --secrets EXAMPLE_API_KEY -- printenv EXAMPLE_API_KEY
zn run: Not allowed: `printenv` is not allowed to use EXAMPLE_API_KEY yet. The user can allow it from their own terminal: zn secret allow EXAMPLE_API_KEY --command printenv (for HTTP APIs, the secrets_http_request tool of the zn "secrets" MCP server needs no command allowed).
```

The exit code is `77`. Nothing was started.

## 4. `run`: allow the command, then use the secret

Allow `printenv` for this secret. The change is confirmed in the vault prompt, not in the terminal where you typed it:

```text
$ zn secret allow EXAMPLE_API_KEY --command printenv
Confirm the change in the zn vault prompt (system dialog or the `zn unlock --foreground` terminal).
EXAMPLE_API_KEY: mode=env hosts=- commands=printenv http=header
```

The vault prompt shows this, and you answer `y`:

```text
zn: change the policy of secret EXAMPLE_API_KEY?
    Secret: EXAMPLE_API_KEY
    Change: commands + printenv
    If you did not just ask for this in your own terminal, choose Deny.
  Allow? [y/N]
```

Run the command again. The first use of a secret by a command asks once more, and shows the program that will run. The `Runs:` and `Project:` lines, which are paths on your machine, are left out here:

```text
zn: let `printenv` use secret EXAMPLE_API_KEY?
    Secret: EXAMPLE_API_KEY (the value goes into the process)
    Command: printenv
    If you did not just start this command, choose Deny.
  Allow? [y/N]
```

After `y`, the command runs:

```text
$ zn run --secrets EXAMPLE_API_KEY -- printenv EXAMPLE_API_KEY
zn run: first use of EXAMPLE_API_KEY with `printenv`: confirm it in the zn vault prompt (dialog or the `zn unlock --foreground` terminal)
__ZN_EXAMPLE_API_KEY__
```

The process got the real value in its environment. `printenv` printed it, and `run` replaced it with the marker on the way out, which is what the agent would see. The exit code is `0`, the exit code of your command.

## 5. `run` also fills a marker that comes from the environment

If your shell or direnv loads the shadowed `.env`, the variable holds a marker. `run` fills it in the same way, with no `--secrets`, when the secret allows that program and you have approved it:

```text
$ EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__ zn run -- printenv EXAMPLE_API_KEY
__ZN_EXAMPLE_API_KEY__
```

This is one way to run an app that reads its `.env` after `env shadow`.

## 6. `env unshadow`: put the values back

Give the name of the encrypted copy from step 2:

```text
$ zn env unshadow .env --backup ENVBAK_X91D750C8D202611081314
Write plain-text values back to .env? [y/N] y
Restored .env from ENVBAK_X91D750C8D202611081314.
```

This one asks twice: in the terminal where you ran it, and in the vault prompt, which says that the values leave the vault in clear text. The file holds the original values again:

```text
EXAMPLE_API_KEY=sk_test_example_0123456789
EXAMPLE_WEBHOOK_SECRET=FAKE_TOKEN_1234567890
PORT=3000
```

The secrets stay in the vault after `env unshadow`: `zn run --secrets EXAMPLE_API_KEY -- printenv EXAMPLE_API_KEY` still works. `zn secret list` shows them, and the encrypted copy, which `zn secret rm ENVBAK_X91D750C8D202611081314` deletes once you no longer need it.

## Which one to use

- You have a `.env` file with real values and an agent works in that folder: `env shadow`. Then start the app with `run`.
- A program needs a secret you never keep in a file, for example a database password: store it with `zn secret set NAME --command <program>` and start the program with `run`.
- You only want to try a command once with a value, without touching any file: `run`.
- You are about to remove zn-gate: `env unshadow` first, so the values are not lost with the vault.

## What to check

- After `env shadow`, `cat .env` shows markers and no real value.
- `run` needs the command to be allowed for the secret. If it says `Not allowed`, the message names the `zn secret allow` command to run in your own terminal.
- `env shadow` and `env unshadow` change nothing when your agent runs them: they exit with `77`. `run` is the command your agent uses, and only for what you allowed.
- `run` hides the value in the output, but the program itself can still read it and pass it on. Allow a specific program, not an interpreter. See [What an environment variable does and does not hide](../secrets.md#4-let-a-command-use-a-secret).

## See also

- [Example: a `.env` file round trip through the vault](env-file-round-trip.md)
- [Keep secrets out of your coding agent](../secrets.md)
- [`env shadow`](../cli.md#env-shadow), [`env unshadow`](../cli.md#env-unshadow) and [`run`](../cli.md#run) in the command line reference
- [Your `.env` files and the vault](../uninstall.md#your-env-files-and-the-vault)
