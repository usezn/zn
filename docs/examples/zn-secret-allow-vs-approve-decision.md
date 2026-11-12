# Example: `secret allow` or `secret approve`?

Two vault commands sound alike and are often mixed up: `zn-gate secret allow` and `zn-gate secret approve`. Both exist and both change what a command may do with a secret, but they answer different questions. This page is a short decision list, with the output of real runs against a throwaway vault. For the reference, read the [CLI page](../cli.md#secret-allow) and the [secrets page](../secrets.md).

The secret is a made-up `DEMO_TOKEN` and the program is `printenv`. Messages print the command in the form that works on your machine (for example `npx -y zn-gate@<version> unlock`), and here it is shortened to `zn-gate`. The vault ran in a terminal of its own, started with `zn-gate unlock --foreground`, which is where its prompts appeared. In the prompts, the project is shown as `~/proj` and the full path of the program is replaced by `<full path of printenv>`. Run both commands yourself, in your own terminal: they need a terminal, and an agent cannot answer the prompts.

## The short answer

| | `secret allow` | `secret approve` |
|---|---|---|
| Question it answers | Which programs or hosts may use this secret at all? | Do I accept the first use of this secret by a program that is already allowed? |
| What it changes | The policy of the secret: hosts, commands, where in an HTTP request, and the mode. | Records one first-use approval for one secret and one command. |
| Needs the command to be allowed already | No. This is the command that allows it. | Yes. Otherwise it refuses. |
| What the vault asks | `change the policy of secret DEMO_TOKEN?` | `let printenv use secret DEMO_TOKEN?` |
| Needed before a program can use the secret | Yes. | No: the vault asks at the first use if you did not approve ahead of time. |

## Use `secret allow` when

- The secret has no program yet, or you want to add a host or a program, or change the mode.
- A run says that the program is not allowed to use the secret yet. This is the message for a program that is not in the list of the secret:

  ```text
  zn run: Not allowed: `printenv` is not allowed to use DEMO_TOKEN yet. The user can allow it from their own terminal: zn secret allow DEMO_TOKEN --command printenv (...)
  ```

Run it and answer the vault prompt:

```bash
zn-gate secret allow DEMO_TOKEN --command printenv
```

```text
zn: change the policy of secret DEMO_TOKEN?
    Secret: DEMO_TOKEN
    Change: commands + printenv
    If you did not just ask for this in your own terminal, choose Deny.
  Allow? [y/N] y
```

and in the terminal where you ran the command:

```text
Confirm the change in the zn vault prompt (system dialog or the `zn unlock --foreground` terminal).
DEMO_TOKEN: mode=env hosts=- commands=printenv http=header
```

`secret allow` needs at least one option and adds to the lists. With `--replace`, it swaps them instead.

## Use `secret approve` when

- The program is already allowed, and you want to accept its first use now, before an agent runs it. The prompt would otherwise appear in your vault terminal at the first `zn-gate run`.

```bash
zn-gate secret approve DEMO_TOKEN --command printenv
```

```text
zn: let `printenv` use secret DEMO_TOKEN?
    Secret: DEMO_TOKEN (the value goes into the process)
    Command: printenv
    Runs: <full path of printenv>
    Project: ~/proj
    If you did not just start this command, choose Deny.
  Allow? [y/N] y
```

```text
Approved DEMO_TOKEN for `printenv`.
```

After that, `zn-gate run --secrets DEMO_TOKEN -- printenv DEMO_TOKEN` ran without a new prompt. The approval belongs to the value: if you remove the secret, or store a different value under the same name, zn asks again.

## What happens if you do it in the wrong order

`secret approve` before `secret allow` is refused, and it tells you what to run first (exit code 77):

```text
zn secret: Not allowed: `printenv` is not in allowCommands for DEMO_TOKEN. First: zn secret allow DEMO_TOKEN --command "printenv"
```

The same happens for a command that is not in the list, for example `cat`.

## You can skip `secret approve`

`secret approve` is optional. In a second run, the secret was allowed and then used straight away. The first `zn-gate run` said this, the vault terminal asked the same question as above, and after `y` the program ran and printed the marker `__ZN_DEMO_TOKEN__`. The run after that needed no prompt.

```text
zn run: first use of DEMO_TOKEN with `printenv`: confirm it in the zn vault prompt (dialog or the `zn unlock --foreground` terminal)
```

If you answer `n`, the first use is refused. `secret approve` then exits with 77 and the message `declined by the user`. A `run` prints this, runs nothing and exits with 77:

```text
zn run: Not allowed: first use of DEMO_TOKEN with `printenv` was not approved (declined by the user. Next step: nothing was changed. Do not retry the same request; finish the task another way.). Nothing was run or sent. Do not retry the same request; finish the task another way.
```

## Both need a person

Run without a terminal, as a script or an agent would, both commands refuse and change nothing:

```text
zn secret: Not allowed: zn secret allow needs an interactive terminal. Open a terminal window yourself and run it there.
```

If the vault was unlocked without a desktop and without `--foreground`, there is no place for the prompt, and a policy change or a first use is refused. Lock it and unlock it in a terminal of its own with `zn-gate unlock --foreground`.

## Related

- [Secrets in the vault](../secrets.md)
- [Store a secret and run a program that uses it](secret-set-and-run.md)
- [Piping a vault value into another tool](zn-secret-get-in-a-pipe.md)
- [`secret allow` and `secret approve` in the command reference](../cli.md#secret-allow)
