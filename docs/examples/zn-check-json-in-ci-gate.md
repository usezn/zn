# Example: fail a CI job when `check --json` reports a problem

This page shows a GitHub Actions job that runs `zn-gate check --json` and fails when the result is not protected. The job log then says which agent is not protected and what to run to fix it. The example uses no real values. For every option, see [check](../cli.md#check) and [Machine-readable output](../check.md#machine-readable-output).

## What the check decides

`check` makes a temporary folder with a fake key and an ordinary file. For each agent that is set up for the user who runs it, it asks zn whether the agent is blocked from reading the key file. Nothing is sent over the network, and no setting changes.

With `--json` it prints one JSON object on stdout and nothing else. The exit code is the same as in the text form:

- `0` when at least one agent is set up and every agent that is set up is protected.
- `1` when an agent is not protected, when no agent is set up, or when the project rules file has errors.
- `2` when an option is not known, for example a typo in the flags.

## Where this gate can pass

The check looks only at the agents set up for the user that runs it. A hosted CI runner has none, so the check exits with `1` there even when your code is fine. On a machine with no agent set up, every agent comes back as `not-found` and the exit code is `1`.

Use this job on a machine where zn is already set up for your agent, for example a self-hosted runner on which the agent's hooks were installed beforehand.

## The job

```yaml
name: zn check

on:
  pull_request:

permissions:
  contents: read

jobs:
  zn-check:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Run the check
        shell: bash
        run: |
          set -o pipefail
          npx --yes zn-gate@1.15.0 check --json | tee zn-check.json
      - name: Explain the result
        if: ${{ always() && hashFiles('zn-check.json') != '' }}
        shell: bash
        run: |
          jq -r '.agents[] | select(.state == "not-protected") | "\(.name): \(.reason). Fix: \(.fix)"' zn-check.json
          jq -r '.project_rules_errors[] | "Project rules: \(.)"' zn-check.json
          if [ "$(jq '[.agents[] | select(.state == "protected")] | length' zn-check.json)" = "0" ]; then
            echo "No agent is set up for this user, so the check cannot pass on this machine."
          fi
```

- Replace `self-hosted` with the labels of your runner.
- The version is pinned in the command (`zn-gate@1.15.0`), so a new release cannot change what the job runs.
- `set -o pipefail` makes the step fail with the exit code of `zn-gate`, not the exit code of `tee`.
- `permissions: contents: read` gives the job nothing else, and `persist-credentials: false` does not leave the token in the checkout.
- The second step runs even when the first one failed (`always()`), and it only runs when `zn-check.json` exists.

## What the JSON contains

These are the fields the job reads. The full list is in [Machine-readable output](../check.md#machine-readable-output).

- `exit_code`: `0` or `1`. The same value the process exits with.
- `protected`: `true` when `exit_code` is `0`.
- `agents`: one entry per supported agent, with `id`, `name` and `state`. The states are `protected`, `not-protected`, `not-set-up`, `project-only` and `not-found`.
- `reason` and `fix`: why an agent is not protected, and what to run in your own terminal to fix it. Both are empty for a protected agent.
- `project_rules_errors`: the errors in the project rules file, if any. Each one fails the check.

Home folders appear as `~` in the output, and no secret value is printed.

## What the job prints

When an agent is not protected, the second step prints one line for it. This line is made up for the example:

```text
Claude Code: its zn hook is turned off in ~/.claude/settings.json. Fix: run `zn hooks install claude-code` in your own terminal
```

## Exit codes

| Code | Meaning for the job |
|---|---|
| `0` | At least one agent is set up and every agent that is set up is protected. The job passes. |
| `1` | An agent is not protected, no agent is set up, or the project rules file has errors. The job fails. |
| `2` | The command was used wrongly, for example an option it does not know. The job fails. |

## Where to go next

- [check](../cli.md#check), the reference for `check`, `--hooks` and `--json`
- [Machine-readable output](../check.md#machine-readable-output), every field of the JSON
- [Check that it works](../check.md), what the text output means
- [Exit codes](../exit-codes.md), one page with the code of every command
- [CI secret-scan gate](ci-secret-scan-gate.md), the same pattern for `scan`
