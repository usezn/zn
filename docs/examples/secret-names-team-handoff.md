# Example: hand a project to a teammate with a list of secret names

When someone else takes over a project, they need to know which secrets it uses: the names, such as `EXAMPLE_API_KEY`. They do not need your values. This page shows how to make the list from `secret list`, what to send, and how the teammate creates their own values with `secret set`. Everything here is documented in [Keep secrets out of your coding agent](../secrets.md) and the [command reference](../cli.md#secret-list). The names below are made up.

Run every command in your own terminal. The commands that add or change a secret need a person at a terminal, and they refuse to run inside an agent.

## Rule: values are never shared

- Never send a value: not in chat, email, a ticket, a repository, a `.env` file or a screenshot.
- The vault is per machine. It is an encrypted file on your computer, and its key is kept in your system keychain. Your teammate's vault is separate and starts empty. A value you stored on your machine does not reach theirs.
- The teammate types their own value, from their own account or key, at the hidden prompt of `secret set`.

## 1. List the names

The vault must be unlocked first:

```bash
npx -y zn-gate unlock
npx -y zn-gate secret list
```

`secret list` prints one line per secret, with its mode and the hosts or commands it may be used with. It never prints a value. The shape of a line is like this (made-up names):

```text
  EXAMPLE_API_KEY               env     commands=printenv
  EXAMPLE_HOST_TOKEN            proxy   hosts=api.example.com
```

The names are not a secret, so the command does not refuse when an agent runs it. The commands that add, change or remove a secret do refuse.

If the list ends with a section titled `Requested by agents`, leave that section out. It shows names an agent asked for that are not stored yet, not secrets you have.

## 2. Copy the names into the handoff note

Copy only the first column of each line: the names. You can leave out the mode, hosts, commands and last-used columns, because the teammate sets their own rules (step 3 below). Keep the list in the same spelling as the project uses, because the marker an agent sees is built from the name: `EXAMPLE_API_KEY` becomes `__ZN_EXAMPLE_API_KEY__`.

A handoff note can be as short as this:

```text
Secrets this project needs (names only, values are not shared):
- EXAMPLE_API_KEY: used by the billing script, via printenv
- EXAMPLE_HOST_TOKEN: used by the sync job, sent to api.example.com
Create your own values with zn-gate secret set, on your machine.
```

## 3. The teammate creates their own values

The teammate does these steps in their own terminal, on their own computer:

1. Install zn-gate once: `npm install -g zn-gate`. Each machine needs it.
2. Unlock the vault. The first unlock creates it: `zn-gate unlock`.
3. For each name, store a value and set where it may be used. Use the same options the project needs:

   ```bash
   npx -y zn-gate secret set EXAMPLE_API_KEY --command printenv
   npx -y zn-gate secret set EXAMPLE_HOST_TOKEN --host api.example.com
   ```

   zn asks for the value at a hidden prompt. The teammate types their own value there. `--host` and `--command` are the same options as in [the command reference](../cli.md#secret-set). To change them later, use `zn-gate secret allow`.

4. Check the result: `npx -y zn-gate secret list`. Every name from the handoff note should appear, spelled the same way.

The first time a program uses a secret, the vault asks the teammate to confirm in its own dialog. That is expected; the agent cannot answer it.

## What the names must match

- A name uses upper-case letters, digits and single underscores, such as `EXAMPLE_API_KEY`.
- A name that differs by one letter is a different secret. If the project's scripts read `EXAMPLE_API_KEY`, the teammate must store the value under that exact name.
- The name comes from the project. The value and the hosts or commands it may be used with are set per machine.

## More

- [Keep secrets out of your coding agent](../secrets.md): the vault, and the `secret` commands
- [Store a secret and run a program with it](secret-set-and-run.md)
- [Command reference: `secret`](../cli.md#secret-list)
- [zn Team on a developer machine](../team.md): what an organization can see and do on each machine
