# Example: read `zn-gate check --json` with jq in a shell script

A short shell script that runs `zn-gate check --json`, reads the answer with `jq` and stops with a clear message when an agent on the machine is not protected. The script was run against throwaway home folders; the output below is what it printed. For every field of the JSON, read [Machine-readable output](../check.md#machine-readable-output). For every exit code, read [Exit codes](../exit-codes.md).

## What the command gives a script

```bash
zn-gate check --json
```

It prints one JSON object on standard output and nothing else, and its exit code is the same as in the text form:

- `0`: at least one agent is set up and every agent that is set up is protected.
- `1`: an agent is not protected, no agent is set up, or the project rules file has errors. The JSON is printed in this case too.
- `2`: an option it does not know. It prints no JSON, only a message on standard error.

The keys this script uses:

| Key | What it holds |
| --- | --- |
| `schema` | The version of the format, `1` today. |
| `protected` | `true` when `exit_code` is `0`. |
| `agents` | One entry per supported agent. |
| `agents[].state` | `protected`, `not-protected`, `not-set-up`, `project-only` or `not-found`. |
| `agents[].protected` | `true` only for the `protected` state. |
| `agents[].reason` and `agents[].fix` | Why an agent is not protected, and what to run. They are empty when there is nothing to say. |
| `project_rules_errors` | Errors in the project rules file, as a list of strings. |

`jq` is a separate program that you install yourself. The script needs nothing else besides `zn-gate` on the PATH.

## The script

```sh
#!/bin/sh
# Stop the job when zn-gate says an agent on this machine is not protected.
out=$(zn-gate check --json)
code=$?

# 0 and 1 both print the JSON. Any other code means the command did not run as expected.
if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then
  echo "zn-gate check did not run (exit code $code)" >&2
  exit 2
fi

# The field names are stable while "schema" is 1.
if [ "$(printf '%s' "$out" | jq -r '.schema')" != "1" ]; then
  echo "unknown zn-gate check JSON format" >&2
  exit 2
fi

# One line per agent that is set up but would not stop a secret.
printf '%s' "$out" | jq -r '.agents[] | select(.state == "not-protected") | "NOT protected: \(.name): \(.reason)\n  fix: \(.fix)"' >&2

# Errors in the project rules file also make the exit code 1.
printf '%s' "$out" | jq -r '.project_rules_errors[] | "project rules: \(.)"' >&2

# Count the agents that are protected.
n=$(printf '%s' "$out" | jq '[.agents[] | select(.protected)] | length')

if [ "$(printf '%s' "$out" | jq -r '.protected')" = "true" ]; then
  echo "zn-gate: $n agent(s) protected"
  exit 0
fi

if [ "$n" -eq 0 ]; then
  echo "zn-gate: no agent is protected on this machine" >&2
fi
exit 1
```

Save it as `check-hooks.sh` and run `sh check-hooks.sh`. The script exits `0` when the machine is protected, `1` when it is not, and `2` when `zn-gate check` or its JSON was not what the script expects.

## What it prints

Each run below used a different throwaway home folder.

An agent is set up and protected:

```text
zn-gate: 1 agent(s) protected
```

The script exits `0`.

The same agent, after its settings file got `disableAllHooks` set to `true`, which turns every hook of the agent off:

```text
NOT protected: Claude Code: ~/.claude/settings.json sets disableAllHooks, so no hooks you install run, zn's included. Remove that setting to turn them on
  fix: change that Claude Code setting as it says, then run `zn-gate check` again
zn-gate: no agent is protected on this machine
```

The script exits `1`. Your home folder is shown as `~` in the JSON.

A machine where no agent is set up:

```text
zn-gate: no agent is protected on this machine
```

The script exits `1`, because `check` exits `1` until an agent is set up. To set one up, run `zn hooks install <agent>` in your own terminal (see [Install and remove the hooks of one agent](hooks-install-and-uninstall.md)).

## Without jq

If you would rather not install `jq`, `zn-gate` needs Node.js anyway, so Node can read the same JSON:

```bash
zn-gate check --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);for(const a of r.agents)if(a.state==="not-protected")console.error("NOT protected: "+a.name+": "+a.reason);process.exit(r.protected?0:1)})'
```

This one-liner prints the same `NOT protected` lines and exits with the value of `protected`. It does not check `schema` or `project_rules_errors`.

## Things to know

- `check` runs the hooks that are installed, in a temporary folder. It sends nothing and changes no setting, so it is safe to run on a schedule.
- An agent that is not on the machine has the state `not-found` and does not count against the result. An agent that is set up for one project only has the state `project-only`.
- `message` holds what the agent is told when it tries to read the fake key, and only for a protected agent. The script does not use it.
- To see every installed hook and whether it is current, run `zn-gate check --hooks`. It prints text, not JSON.

## See also

- [Check output explained](check-output-explained.md): the text form of the same check, line by line.
- [Scripting](scripting.md): exit codes and JSON from `scan` and `analyze` in a shell script and a CI job.
- [Check](../check.md): what each result means and how to fix it.
