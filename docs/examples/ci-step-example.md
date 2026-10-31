# Example: a CI job that runs the check and reads its exit code

This page shows one fake CI job. It runs the zn-gate audit on a pull request and then reads the exit code of the audit. It uses only what [GitHub Action](../github-action.md) and [Exit codes](../exit-codes.md) describe.

## The job

```yaml
name: zn-gate check

on:
  pull_request:

permissions:
  contents: read

jobs:
  zn-gate-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Audit agent configs
        id: zn
        uses: usezn/zn@746be20f3276ab0d589f2d6df941b5d31a5396d8 # v1.13.1
        with:
          version: '1.13.1'
          mode: audit
          path: '.'
          format: github
      - name: Read the exit code
        if: ${{ !cancelled() }}
        env:
          AUDIT_EXIT_CODE: ${{ steps.zn.outputs.audit-exit-code }}
        run: |
          case "$AUDIT_EXIT_CODE" in
            0) echo "Audit clean: nothing at or above the threshold." ;;
            1) echo "Audit found problems at or above the threshold." ;;
            2) echo "Audit error: wrong usage or a path that is not a folder." ;;
            "") echo "The audit did not run." ;;
          esac
```

## What each step does

- The audit step runs `zn audit` on the checked-out repository with `mode: audit`. With the default `fail-on-threat: 'true'`, it fails the step on findings of severity `high` or above (the default `severity-threshold`). Findings show as annotations because `format: github` is the default.
- The last step reads the `audit-exit-code` output of the audit step. `if: ${{ !cancelled() }}` makes it run even when the audit step failed.

## The exit codes you can get

| `audit-exit-code` | Meaning |
|---|---|
| `0` | Clean. |
| `1` | Findings at or above the threshold. |
| `2` | Error. |
| empty | The audit did not run. |

The same codes apply to `zn-gate audit` on your own machine, for example `npx -y zn-gate audit .`.

## Report-only mode

With `fail-on-threat: 'false'` the exit codes stay `0`, so do not use `audit-exit-code` to detect findings in that mode.

## Related

- [GitHub Action](../github-action.md): every input and output.
- [Exit codes](../exit-codes.md): the exit code of every command.
