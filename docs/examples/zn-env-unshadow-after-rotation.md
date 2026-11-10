# Example: restore a `.env` file after you rotate its secret

This page follows one `.env` file through `env shadow`, a secret rotation and `env unshadow`. It shows why the restore step brings back the old value, and what to do instead. All names and values are made up. Run every command in your own terminal: the `env` commands refuse to run inside an agent or without a terminal.

It only strings together steps that [Keep secrets out of your coding agent](../secrets.md) and the [command line reference](../cli.md) describe. For the basic round trip, see [a `.env` file round trip through the vault](env-file-round-trip.md).

## 1. The starting point

Say the `.env` file of a project was shadowed, so it holds only a marker:

```text
EXAMPLE_API_KEY=__ZN_EXAMPLE_API_KEY__
```

When `env shadow` ran, it printed the name of an encrypted copy of the original file, for example `ENVBAK_X...D...`. Keep that name. Then the key is rotated: the provider issues a new value, and you store it in the vault.

## 2. The restore brings back the old text

The encrypted copy is the text of the file as it was before `env shadow` wrote the markers. `env unshadow` writes that copy back as it is. It does not look at what the vault holds now.

So after a rotation, the restored file holds the value from before the rotation. Here is what it looks like with fake values, after the vault had been given a new value:

```text
$ npx -y zn-gate env unshadow .env --backup ENVBAK_X...
Restored .env from ENVBAK_X....
$ cat .env
EXAMPLE_API_KEY=example-not-a-real-key
```

The vault held `example-rotated-key-9999` at that moment, and the file now holds the older `example-not-a-real-key`. The restore did not change the vault.

## 3. Pick one of two ways

**A. Keep the markers.** If you still use the project with zn, you do not need a plain file. Start the program through `zn run`, which reads the current value from the vault when it starts. See [step 3 of the round trip](env-file-round-trip.md#3-a-command-still-gets-the-value) and [`run`](../cli.md#run):

```bash
npx -y zn-gate run --secrets EXAMPLE_API_KEY -- <command>
```

**B. You need the plain text in the file.** Do the steps in this order, so the file and the vault end up with the same new value:

1. Rotate the key at your provider, then store the new value in the vault with the hidden prompt. `--force` replaces the old value ([`secret set`](../cli.md#secret-set)):

   ```bash
   npx -y zn-gate secret set EXAMPLE_API_KEY --force
   ```

2. Restore the file from the encrypted copy and confirm in the vault prompt ([`env unshadow`](../cli.md#env-unshadow)):

   ```bash
   npx -y zn-gate env unshadow .env --backup ENVBAK_X...
   ```

3. Open `.env` and replace the old value with the new one. Type or paste it yourself, outside your agent.

4. If you want markers again, shadow the file. The value in the file now matches the value in the vault, so no `--force` is needed:

   ```bash
   npx -y zn-gate env shadow .env
   ```

   The output says `Shadowed 1 value(s) in .env` and the file holds only the marker again.

## 4. Do not do this

- **Do not run `env shadow --force` on a file that still holds the old value.** `--force` replaces the vault value with the one in the file, so the old value would take the place of the new one. In a test with fake values, the vault held `example-rotated-key-9999`. After `env shadow .env --force` on the restored file, it held `example-not-a-real-key`. Without `--force`, a different stored value is not replaced; the command prints a `skip` line for it instead.
- **Do not expect the restore to keep your later edits.** The copy holds the text from the moment of `env shadow`. Restoring writes that whole text into the file, so any change made to the file after shadowing is replaced.

## 5. What `env unshadow` does not offer

- **No preview.** `env unshadow` has no `--dry-run`. The confirmation question does not show the text it will write.
- **The backup name is checked first.** The name must look like `ENVBAK_X`, eight hex characters, `D` and twelve digits. Without a valid `--backup` the command stops with exit code `64` and prints the usage.
- **Answering no changes nothing.** At the confirmation question, anything other than `y` or `yes` ends the command with exit code `1`, and the file is not touched.
- **A name that is not in the vault** stops the command with an error and exit code `1`, and the file is not touched.
- **Only in a terminal.** From an agent or a pipe the command exits `77` and changes nothing.

## Related

- [A `.env` file round trip through the vault](env-file-round-trip.md): the basic shadow and unshadow steps.
- [`env` in the command reference](../cli.md#env): the exit codes of both `env` commands.
- [Your `.env` files and the vault](../uninstall.md#4-your-env-files-and-the-vault): what to do before you remove zn-gate.
