# Example: `zn-gate init` in a Docker image build

A `RUN` step of a `docker build` has no terminal, and `zn-gate init` and `zn hooks install` are made for a person at a terminal. This page shows what each of them does without one, so you know why `RUN zn-gate init` does not set anything up, and what to put in an image instead. All names and values are made up. For every option and exit code, read [init](../cli.md#init), [exit codes](../exit-codes.md) and [Deploy zn-gate's hooks to every machine](../team.md#deploy-zn-gates-hooks-to-every-machine-managed-settings).

## What was run, and what was not

The commands below were run on a Linux host with Node.js, in throwaway home folders, with standard input closed (`</dev/null`). That is the same situation as a build step: no terminal. **No container was started and `docker build` was not run**, because Docker was not available where this page was written. So the Dockerfile lines on this page were not built, and the paths in them are the ones zn-gate prints for Linux.

## `init` without a terminal

`init` asks before each step, and it only asks when it runs in a terminal and not an AI agent. Without one it prints the steps it would have taken and changes no agent setting. In an image there is usually no coding agent, so this is what a build sees:

```bash
zn-gate init
```

```text
zn-gate init: set up zn for the coding agents on this machine

  -  Claude Code  not found on this machine
  -  Codex CLI    not found on this machine
  -  Cursor       not found on this machine
  -  OpenCode     not found on this machine
  -  Antigravity  not found on this machine
  -  GitHub Copilot (VS Code, CLI) not found on this machine
  -  Gemini CLI (experimental) not found on this machine
  -  ZCode        not found on this machine

No supported coding agent was found (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app). Nothing was changed.
Install one, then run `npx -y zn-gate init` again. Other editors: https://usezn.com/docs/install
(To wrap the MCP servers in your agent configs, which `zn-gate init` used to do: `zn-gate init --wrap-mcp`.)
```

The exit code is `1`. In a Dockerfile, a `RUN` step that exits `1` stops the build.

With an agent folder present (`~/.claude` and `~/.cursor` were created), the output instead says "This is not an interactive terminal, so zn only prints the steps. Nothing was changed.", lists the steps to run in your own terminal, and still exits `1`. In both runs no agent settings file was written. It did leave a few small files in the home folder: a record under `~/.zn` and npm logs under `~/.npm`.

So `RUN zn-gate init` either fails the build, or, with `|| true` after it, passes and leaves the image with no hooks. Do not add `|| true`: it hides the missing protection.

## `hooks install` without a terminal

```bash
zn hooks install claude-code
```

```text
zn hooks: Not allowed: zn hooks install needs an interactive terminal. Open a terminal window yourself and run it there.
```

The exit code is `77`. Setting `CI=true` did not change this. It is the same refusal as when an agent runs the command, so a script cannot get around it. This also means that the hooks cannot be installed from a container entry point that has no terminal. In a container that you start with `docker run -it`, or enter with `docker exec -it`, standard input is a terminal, and `zn-gate init` then asks `[y/N]` before each step, as it does on your own machine (this was seen with a pseudo-terminal on the host, not in a container).

## What does work without a terminal

| Command | Without a terminal |
| --- | --- |
| `zn-gate init --wrap-mcp --dry-run` | Prints what it would wrap and changes nothing. Exit `0`. |
| `zn-gate uninstall --dry-run` | Prints the removal plan, or says nothing was found. Exit `0`. |
| `zn-gate check` and `zn-gate check --json` | Run as usual. Exit `1` until an agent is set up and protected. |
| `zn-gate scan` and `zn-gate audit` | Run as usual, and their exit codes can stop a build. |
| `zn team managed-config` | Prints the managed settings files. It needs no account and writes nothing. |

`init --wrap-mcp` without `--dry-run` has no terminal check in the code, so in a build it would wrap the MCP servers it finds in the agent configs of the build user. That was not run: use `--dry-run` first.

## What to put in an image instead

Hooks are written to the home folder of the user who runs the command. A build usually runs as root, while the agent may run as another user, so a `hooks install` in a build step would write to the build user's home folder, not to the home folder of the user who runs the agent. For an image that people run a coding agent in, use these three parts:

1. **Install the package.** The managed hooks call `zn` from the PATH, so zn-gate must be installed in the image. Pin an exact version so a rebuild gives the same image:

   ```dockerfile
   RUN npm install -g zn-gate@<version>
   ```

   Use any image that has Node.js 18 or later. Replace `<version>` with the release you want.

2. **Copy the managed settings.** On any machine with zn-gate installed, print the file for Claude Code on Linux and keep its content:

   ```bash
   zn-gate team managed-config --agent claude-code --os linux --json | jq -r '.files[0].content' > managed-settings.json
   ```

   The JSON has `schema`, and `files`, a list with one entry per agent. Each entry has `file` (here `/etc/claude-code/managed-settings.json`), `content` and `notes`. The saved file was checked to be valid JSON with a `hooks.PreToolUse` entry. Then, in the Dockerfile:

   ```dockerfile
   COPY managed-settings.json /etc/claude-code/managed-settings.json
   ```

   Claude Code reads managed settings from that folder, and they sit above the user's own settings (see [Deploy zn-gate's hooks to every machine](../team.md#deploy-zn-gates-hooks-to-every-machine-managed-settings)). Cursor and Codex have their own files: print them with `--agent cursor` or `--agent codex`.

3. **Check at run time.** When the container starts, or in a test of the image, run `zn-gate check --json` or the script in [Read check --json with jq](zn-check-json-with-jq-in-a-shell-script.md). `check` counts hooks set through managed settings and names the file. It was not run against a managed file here, because writing to `/etc` needs root, and no container was available.

## Things to know

- `npm install -g zn-gate` has a `postinstall` step. It only rewrites the hook launchers that zn-gate itself wrote earlier, so on a new image it has nothing to do.
- `scan` and `audit` in a build do not need hooks. A `RUN zn-gate scan .` step fails the build when it finds a secret (exit `1`) or could not read part of the project (exit `3`).

## See also

- [Init and uninstall](init-and-uninstall.md): the same commands in a terminal, with a dry run.
- [Team managed config](team-managed-config.md): the managed settings files for every agent.
- [Exit codes](../exit-codes.md): `1`, `3` and `77` in one table.
