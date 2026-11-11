# Example: use a secret from a shell script with zn run

A script that calls an API needs the key, but the script should not read it. This page shows a short bash script that starts one program through `zn run`. The program reads the secret from its environment variable, and the script never holds the value. The name and the value are made up. Assume you have done step 2 of [store a secret and run a program](secret-set-and-run.md): `EXAMPLE_API_KEY` is in the vault and `printenv` is allowed to use it.

## The script

Save this as `call-example-api.sh`:

```bash
#!/usr/bin/env bash
# Runs one program with EXAMPLE_API_KEY in its environment. The script never reads the value.
set -euo pipefail

npx -y zn-gate run --secrets EXAMPLE_API_KEY -- printenv EXAMPLE_API_KEY
```

`--secrets` names the secret, and everything after `--` is the program. In a real script, the program would be the tool that reads `EXAMPLE_API_KEY` from its environment. Only the program is allowed to see the value, and only while it runs.

Run it from your own terminal:

```bash
bash call-example-api.sh
```

The output is the marker, not the value:

```text
__ZN_EXAMPLE_API_KEY__
```

The exit code of the script is the exit code of `zn run`, which is the exit code of the program.

## When the vault is locked

`zn run` needs the vault to fill in a required secret. If the vault is locked, it does not start the program. It prints one line to stderr and exits with `1`:

```text
zn run: Your secret vault is locked. Unlock it in this terminal with: npx -y zn-gate unlock. Then run this command again.
```

The unlock command in the message depends on how zn is installed. Run it yourself in your own terminal, then run the script again. A script cannot unlock the vault. Because the script uses `set -e`, it stops at that line with exit code `1`.

This is not exit code `77`. `77` means zn refused on purpose, for example because a program is not allowed to use the secret. A locked vault is an error, so it is `1`. See [exit codes](../exit-codes.md#secrets-and-the-vault).

If a secret is only referenced as a marker in the environment, and not named with `--secrets`, `zn run` does not stop. It prints that the vault is locked, leaves the marker as it is, and runs the program. Use `--secrets` in a script that needs the value, so a missing unlock fails loudly.

## Why the script must not echo the variable

Do not add `echo "$EXAMPLE_API_KEY"`, `printf`, `set -x` or a log line that shows the variable. Here is why:

- `zn run` masks only what the program it starts prints (its standard output and standard error). Anything the script itself prints is outside that masking, so the real value would appear in clear text in the terminal, in a log file, or in the output an agent reads.
- `set -x` prints each command after the variables are expanded, so it has the same problem.
- Do not pass `$EXAMPLE_API_KEY` as an argument either, for example `curl -H "Authorization: $EXAMPLE_API_KEY"`. An argument is visible to other processes (`ps`) and to command-line logs. zn refuses a marker in the arguments of `zn run` for the same reason.

The script needs only one thing: the name of the secret after `--secrets`. The value goes to the program's environment, and nowhere else.

## Limits to know

- Allow the program that reads the secret, here `printenv`, and not a shell. If you allow `bash` or `sh`, every script that shell runs can read the secret, and zn warns you about that.
- The program can print or pass on the value it receives. Masking covers the output of the program, not what it sends elsewhere. See [what an environment variable does and does not hide](../secrets.md#4-let-a-command-use-a-secret).
- Check who used the secret with `npx -y zn-gate secret log`. It lists each use without any value.
