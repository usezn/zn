# Example: give a secret to docker compose with zn run

`docker compose` reads a value from the environment of the process that starts it, and `zn run` starts a program with a vault secret in its environment. Combined, the stack gets its database password from the vault, and the password is never written in a project file or printed. All names and values are made up.

Run `zn unlock` and `zn secret set` in your own terminal, not through your agent. Before you start, read the limits at the end: this is a way to run a stack on your own computer, not a way to pass secrets to a CI job.

## What zn run does here

- `zn run --secrets NAME -- <command>` puts the value of `NAME` in the environment of that one process, under that name ([Keep secrets out of your coding agent](../secrets.md#4-let-a-command-use-a-secret)).
- The secret has to allow the command. `--command "docker compose"` allows the words `docker compose` and anything after them, such as `docker compose up` or `docker compose down`. It does not allow `docker run` or any other `docker` command.
- The output is masked: if the value shows up in the output, zn prints its marker instead.
- The vault must be unlocked on this computer. If it is locked, `zn run` stops before `docker` starts.

## 1. Unlock the vault

In your own terminal:

```bash
zn unlock
```

## 2. Store the password for docker compose only

```bash
zn secret set DB_PASSWORD --command "docker compose"
```

zn asks for the value at a hidden prompt. It is never accepted as an argument.

## 3. Refer to the variable in the compose file

The compose file names the variable, not the value:

```yaml
# compose.yaml (illustration; the image is made up)
services:
  app:
    image: example.invalid/app:1.0
    environment:
      DB_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD with zn run}
```

`${DB_PASSWORD:?...}` is docker compose's own syntax: if the variable is missing, compose stops with the message after the `?`. That is a useful check: starting the stack without zn run fails instead of starting with an empty password.

## 4. Start the stack through zn run

```bash
zn run --secrets DB_PASSWORD -- docker compose up -d
```

The first time this pair of secret and command runs, the vault asks you to confirm it in its dialog or in the terminal of `zn unlock --foreground`. The prompt shows the exact program. Later runs do not ask again.

Check that the containers are up. This does not need the secret:

```bash
docker compose ps
```

## 5. Stop the stack

```bash
docker compose down
```

It does not need the secret either.

## Limits

- The value is in the environment of the `docker` and `docker compose` processes. Compose gives it to a container only where the compose file names it, as above. Anyone who can run `docker inspect` on that container can read the value there, so keep that in mind on a shared machine.
- Do not run `docker compose config` outside zn run. Compose prints the file with the values filled in. Through zn run, the output is masked, but only for the forms zn knows (the raw value, base64, hex and URL-encoded). Use `docker compose config` in your own terminal only when you do not mind seeing the value.
- A value in a process environment can be read by other processes of your own user (on Linux, from `/proc/<pid>/environ`). zn run does not hide it from them ([What an environment variable does and does not hide](../secrets.md#4-let-a-command-use-a-secret)).
- Do not use this in CI. `zn run` needs a person at this computer to confirm the first use, and a CI runner has no such person. Read [Agents in CI](../agents-in-ci.md#where-the-zn-gate-action-and-zn-run-fit).

## Related

- [Example: give a secret to one program with zn run](secret-set-and-run.md): the same steps for one program.
- [Example: allow one secret for one program](zn-policy-allow-list-recipes.md): the allow, as a recipe.
- [Command line reference](../cli.md): the options of `run`.
