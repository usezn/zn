# Allow a command to use a secret, then approve it

A stored secret can only be used the way you allowed it. Two commands set that up: `zn-gate secret allow` says which hosts or programs may use a secret, and `zn-gate secret approve` approves, ahead of time, the first use of a secret by a program that is already allowed. This page shows both, what they print, and what a refusal looks like. For all options, see the [command line reference](../cli.md#secret-allow) and the [secrets guide](../secrets.md).

Both commands change what your agent can do, so you run them yourself, in your own terminal. They refuse to run inside an agent or in a script, and each change is confirmed in a prompt that the agent cannot answer.

## What was captured and what is quoted

This page was made on a headless test server, which has no desktop. That matters, because the confirmation prompt is a system dialog on your own desktop, or a question in a terminal that runs the vault.

- Captured for real on the test server: the refusal when there is no terminal, `secret list`, the refusal when there is no way to ask you (`no confirmation channel`), the refusal of `secret approve` for a program that is not allowed yet, and the vault log lines that these attempts left.
- Quoted from the source code of zn-gate, not captured: the text of the confirmation prompt and the lines printed after you answer yes. The prompt appears on your own desktop, so the test server could not show it. Those parts are marked "quoted" below.

The secret, the value and the host are made up (`API_TOKEN`, `FAKE_TOKEN_123`, `api.example.com`). If `zn-gate` is not on your PATH, the messages that zn-gate prints name `npx -y zn-gate@<version>` instead. This page shows `zn-gate`.

## 1. Check what is stored

```bash
zn-gate secret list
```

```text
  API_TOKEN                     proxy
```

The secret was stored with `zn-gate secret set API_TOKEN`, which asks for the value without showing it. The list shows names and settings, never values. `proxy` is the mode: the agent never gets the value; it asks zn-gate to send a request. The mode is explained in the [secrets guide](../secrets.md).

## 2. Allow a host or a program

```bash
zn-gate secret allow API_TOKEN --host api.example.com
zn-gate secret allow API_TOKEN --command psql
```

At least one of `--host`, `--command`, `--in` or `--mode` is needed. `--host` and `--command` can be given more than once. A new entry is added to the existing list; `--replace` swaps the list instead. Allowing a command on a secret in `proxy` mode switches it to `env` mode, which is the mode `zn-gate run` uses.

On a computer where the vault has a way to ask you, `zn-gate secret allow` prints a reminder and then the dialog appears:

```text
Confirm the change in the zn vault prompt (system dialog or the `zn unlock --foreground` terminal).
```

(Captured: this line, printed before the vault asks.)

The prompt asks, with the secret and the change:

```text
change the policy of secret API_TOKEN?
Secret: API_TOKEN
Change: hosts + api.example.com
If you did not just ask for this in your own terminal, choose Deny.
```

(Quoted from the source: the title, the two fields and the closing line. It is shown as a system dialog titled `zn: change the policy of secret API_TOKEN?`, or as a question ending in `Allow? [y/N]` in the terminal where you started `zn-gate unlock --foreground`. Only `y` or `yes` allows it; anything else, or no answer in time, is a no.)

For `--command psql` the `Change` line reads `commands + psql`. If the program is an interpreter such as `node` or `python`, a warning goes first: `Warning: node runs any code it is given; every script it runs could read API_TOKEN.`

After you allow it, the command prints the new settings:

```text
API_TOKEN: mode=proxy hosts=api.example.com commands=- http=header
```

(Quoted from the source: the format of the last line. The values after `=` depend on what you allowed.)

A change that only narrows the policy, for example `--replace` with fewer entries, is not a widening and is applied without a dialog, although the reminder line is still printed. A secret that is not stored is refused with `API_TOKEN is not in the vault`.

## 3. Approve the first use ahead of time

```bash
zn-gate secret approve API_TOKEN --command psql
```

The first time `zn-gate run` hands a secret to a program, the vault asks you. `secret approve` does that approval now, so the agent does not stop at the question later. The command must already be in the allowed list; otherwise it is refused and tells you what to run first. This is what the test server printed when `psql` had not been allowed yet (exit code `77`):

```text
zn secret: Not allowed: `psql` is not in allowCommands for API_TOKEN. First: zn secret allow API_TOKEN --command "psql"
```

(Captured.) Once the command is allowed, `secret approve` first prints any warnings about the program (an interpreter, or a program your user can write to), then:

```text
Confirm it in the zn vault prompt (system dialog or the `zn unlock --foreground` terminal).
```

and the prompt asks:

```text
let `psql` use secret API_TOKEN?
Secret: API_TOKEN (the value goes into the process)
Command: psql
Runs: /usr/bin/psql
If you did not just start this command, choose Deny.
```

(Quoted from the source: the title, the field names and the closing line. The values are examples. The prompt shows the exact program that would run. It can carry more lines: a `Project` field, and warnings when the program is an interpreter or one that your user can write to.) After you answer yes, the command prints:

```text
Approved API_TOKEN for `psql`.
```

(Quoted from the source.)

An approval belongs to the value it was given for. If you remove the secret, or store a different value under the same name, zn asks again. If the program file changes later, the vault asks again too, and the prompt says the program changed since you approved it.

## 4. When the vault cannot ask you

On the test server, the vault was unlocked with a passphrase and no desktop session. Allowing a host was refused, with exit code `77`:

```bash
zn-gate secret allow API_TOKEN --host api.example.com
```

```text
Confirm the change in the zn vault prompt (system dialog or the `zn unlock --foreground` terminal).
zn secret: Not allowed: zn could not ask you outside the agent: no confirmation channel. Start the vault with `zn-gate unlock --foreground` in a terminal of its own (it asks there), or unlock it from a desktop ...
```

(Captured. The message is cut at 300 characters; the end of the sentence, quoted from the source, is "session so zn can show a dialog.")

Nothing was changed. To go on, lock the vault and start it in a terminal of its own, which asks there:

```bash
zn-gate lock
zn-gate unlock --foreground
```

Then run the `secret allow` command again in another terminal and answer the question in the first one. On a computer with a desktop, you do not need this: unlock the vault normally and the dialog appears on your screen.

Unlocking on the test server printed a note about the same limit (captured):

```text
Note: no system dialog is available here, so first-use approvals and policy changes will be refused.
```

## 5. Check the log

Each attempt, allowed or refused, is written to the vault log, without values:

```bash
zn-gate vault log
```

```text
2026-11-08T12:46:30.534Z  allow  -  unlock  -  -    ttl:480m
2026-11-08T12:46:32.854Z  allow  API_TOKEN  set  -  -    created
2026-11-08T12:46:33.158Z  deny  API_TOKEN  set  -  -    no_confirmation_channel
2026-11-08T12:46:33.465Z  deny  API_TOKEN  set  -  -    no_confirmation_channel
chain: valid, 4 records
```

(Captured.) The two `deny` lines are the two refused `secret allow` attempts, each with the reason `no_confirmation_channel`. A prompt you answer no to is logged with the reason `declined_by_user`. A change you confirm is logged as an `allow` line with a reason such as `policy_widened_confirmed`, and a confirmed first use as `ask:yes` with `first_use_approved` (quoted from the source).

## What to check

- You ran the command in your own terminal, not through your agent. Without an interactive terminal it prints `zn secret allow needs an interactive terminal` (or `zn secret approve needs ...`) and exits with `77`.
- The prompt names the secret and the exact change or program you expected. If you did not just start this, choose Deny.
- Allow the specific program (`psql`), not an interpreter such as `node` or `python`, which lets every script it runs read the secret.
- `zn-gate secret list` shows the new hosts and commands, and `zn-gate vault log` shows your decision.

## See also

- [Keep your `.env` values in the vault](../secrets.md): modes, hosts and commands in full.
- [Command line reference](../cli.md#secret-allow): `secret allow` and `secret approve`.
- [Move a `.env` file into the vault](env-file-round-trip.md): where the stored secrets come from.
- [Troubleshooting](../troubleshooting.md): when a command is refused.
