# Example: zn on a shared CI runner, read-only commands only

A shared CI runner is a machine that runs jobs for several repositories or several people, under one user account. The setup commands of zn write to that account's settings, so a job that runs them changes every job that runs after it. This example shows which commands write what, and which commands a CI job should run instead. The repository, the runner and the names are made up.

Run the setup commands on your own computer, in your own terminal. Do not run them in a CI job.

## What each command writes

| Command | Writes | Runs without a person at a terminal |
|---|---|---|
| `npx -y zn-gate init` | Nothing. In a terminal it asks before each step. The steps install zn-gate and run `zn hooks install <agent>` for the agents it finds, which writes the user settings of each agent | No. With no terminal, or when an AI agent runs it, it prints the steps and changes nothing |
| `npx -y zn-gate hooks install <agent>` | The user settings of that agent, for example `~/.claude/settings.json` (or the folder named by `CLAUDE_CONFIG_DIR`). Every project that account opens gets the hooks | No. It refuses without a terminal, or when an agent runs it |
| `npx -y zn-gate hooks install <agent> --project` | The settings of the current folder only, for example `.claude/settings.json` in the repository | No. Same refusal |

The project form is the only one that lives in the repository, and it runs `zn` from the PATH. Each person who opens that project needs zn-gate installed globally. Details are in [hooks install and uninstall](hooks-install-and-uninstall.md).

## Why a shared runner is different

- A user-level hook changes the settings of the runner's account. The next job that runs as that account inherits it, even when it belongs to another repository.
- A project-level hook is written into the checkout, as a file meant to be committed and shared. Writing it from a job is a change to the repository itself.
- A CI job has no terminal. `hooks install` refuses there, and `init` only prints the steps. A job that calls either one changes nothing, or fails.

So the CI job should not install anything. It should run the commands that only read the repository.

## Run the read-only commands in the job

These commands read the files of the checkout and print a report. They change nothing and send nothing. Pin an exact version of the package, for example `npx -y zn-gate@<version>`, so that the job runs the same code every time.

```bash
npx -y zn-gate audit . --format sarif --output zn-audit.sarif --fail-on high
npx -y zn-gate scan . --format github
```

- `audit` reviews the agent configs in the folder: hooks, MCP servers, permissions, instructions and planted programs. It does not look at your home folder unless you add `--include-home`, so a shared runner's account settings are not read. Its exit codes are `0` nothing at or above `--fail-on`, `1` findings at or above it, and `2` a usage error or a path that is not a folder.
- `scan` looks for injection traps and secrets in prompts, markdown, skills and configs. It never prints a matched value. Its exit code `3` means that part of the folder was not read. A CI job should fail on it, not pass, unless you have decided to accept that gap with `--allow-partial`.

`npx -y zn-gate check --json` is not a repository check. It checks the agents set up on the machine that runs it, so on a runner with no agent set up it exits `1`. Use it only to look at a machine you own, for example in a support request.

## What the job must not run

- `init`, `init --wrap-mcp`, `hooks install` and `hooks uninstall`: they change agent settings.
- `unlock`, and the `vault reset`, `vault purge` and `vault forget` commands: the vault belongs to a person at a terminal. The [`unlock` reference](../cli.md#unlock) explains what it needs.
- `run` with a secret: a runner has no place to confirm a first use. For the secrets a CI job needs, use the platform's secrets and environments, as described in [coding agents in CI](../agents-in-ci.md#where-the-zn-gate-action-and-zn-run-fit).

For what the Action covers and what it does not, read [GitHub Action](../github-action.md) and [coding agents in CI](../agents-in-ci.md#what-zn-gate-does-not-protect-in-ci). For a machine that several people share, read [zn-gate on a shared machine](agents-on-a-shared-machine.md).

---
