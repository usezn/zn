# Example: store a secret, then check it with `secret list`

After you store a secret, how do you know it is really in the vault? You cannot read it back: zn-gate never prints a value. What you can do is a three-step check: store it, list it, and use it once. This page shows the output of each step. The name and the value are made up, and the output was printed on a test computer with a temporary home folder.

Do this in your own terminal, not through an agent. The vault must be unlocked first (`npx -y zn-gate unlock`, as in [store a secret and run a program that uses it](secret-set-and-run.md#1-unlock-the-vault)).

## 1. Store the secret

```bash
npx -y zn-gate secret set EXAMPLE_API_KEY --command printenv
```

zn asks for the value at a hidden prompt, so type or paste a fake value such as `example-not-a-real-key-1234`:

```text
Value for EXAMPLE_API_KEY (hidden):
Stored EXAMPLE_API_KEY (env mode). Agents use it as __ZN_EXAMPLE_API_KEY__.
```

`Stored` is the first sign that it worked. A value shorter than 8 characters is refused with `Nothing stored.`, and a name that is already in the vault stops with `EXAMPLE_API_KEY already exists; use --force to replace it`.

## 2. List it

```bash
npx -y zn-gate secret list
```

```text
  EXAMPLE_API_KEY               env     commands=printenv
```

Each line is one secret: its name, the mode (`env` here, `proxy` for a secret used with a web address), and where it may be used (`commands=` for programs, `hosts=` for web addresses). Never a value. If the line is there, the secret is stored and the policy you gave is the one zn will check. With nothing stored, the command prints `No secrets stored.` and how to add one.

If the vault is locked, `secret list` stops with `Your secret vault is locked.` and the command to unlock it. That is a locked vault, not a lost secret.

## 3. Use it once

```bash
npx -y zn-gate run --secrets EXAMPLE_API_KEY -- printenv EXAMPLE_API_KEY
```

The first time a program uses a secret, the vault asks you to confirm. Here the vault was started with `unlock --foreground`, so the question appeared in that terminal (the two paths are replaced with examples):

```text
zn: let `printenv` use secret EXAMPLE_API_KEY?
    Secret: EXAMPLE_API_KEY (the value goes into the process)
    Command: printenv
    Runs: /usr/bin/printenv
    Project: /home/you/project
    If you did not just start this command, choose Deny.
  Allow? [y/N] y
  -> allowed
```

The terminal where you ran `run` printed only the masked value:

```text
__ZN_EXAMPLE_API_KEY__
```

The program did receive the real value, and zn replaced it in what came back, so you see the marker and the agent would see the same. Without a terminal or a system dialog to confirm in, the first use is refused with exit code `77` and nothing runs.

Now list again. The line has a new part, the time of the last use (in UTC):

```text
  EXAMPLE_API_KEY               env     commands=printenv  last used 2026-11-11T12:50:59.854Z
```

## What the three steps tell you

| Step | What you see | What it proves |
|---|---|---|
| `secret set` | `Stored EXAMPLE_API_KEY (env mode)...` | The vault accepted the value. |
| `secret list` | The name, the mode and the allowed programs or hosts | It is stored, with the policy you expect. |
| `run` | The marker, then `last used` in the list | A program you allowed can use it, and the value stays out of the output. |

To see every use later, run `npx -y zn-gate secret log`. Remove the fake secret when you are done with `npx -y zn-gate secret rm EXAMPLE_API_KEY` and lock the vault with `npx -y zn-gate lock`.

## See also

- [Store a secret and run a program that uses it](secret-set-and-run.md): the same commands, with what an agent gets when it is not allowed.
- [Keep secrets out of your coding agent](../secrets.md)
- [Command line reference](../cli.md#secret)
- [All examples](README.md)
