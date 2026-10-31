# Example: write the reach report to a file in CI

A short walk-through of [`zn-gate reach`](../reach.md) in a CI job. The job writes the report to a file and keeps the file as a build artifact. For the full behaviour, flags and limits, read the [full page](../reach.md).

## Write the report to a file

`zn-gate reach` prints the report to standard output, so a shell redirect writes it to a file. Reach is read only, needs no account or API key and sends nothing anywhere.

```bash
npx -y zn-gate reach --json > zn-reach.json
```

Use `--json` for a file a script can read, `--sarif` for SARIF 2.1.0, or no format flag for the plain text report. `--json` and `--sarif` cannot be used together.

The report never contains a secret value. The JSON output holds one full path: `root`, the folder that was checked.

## Keep the file as a build artifact

This workflow runs reach, then keeps the file. The artifact step uses `if: always()`, as the upload step in the [reach page](../reach.md#sarif-and-ci) does, so the file is kept even when the reach step fails.

```yaml
name: zn reach report

on:
  pull_request:

permissions:
  contents: read

jobs:
  reach:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Run zn-gate reach
        run: npx -y zn-gate reach --json > zn-reach.json
      - name: Keep the report
        if: always()
        uses: actions/upload-artifact@<commit-sha> # vX.Y.Z
        with:
          name: zn-reach-report
          path: zn-reach.json
```

Replace `<commit-sha>` with the full commit SHA of the release of the artifact action you want. As in the other workflows in these docs, pin actions by commit SHA, not by tag.

## Fail the job on a finding

By default the report always exits with code 0. To fail the job, add `--fail-on high` to the `run` line:

```bash
npx -y zn-gate reach --json --fail-on high > zn-reach.json
```

Exit code 1 means a finding met `--fail-on`. Exit code 2 means a usage error or a failed run. The file is written by the redirect before the exit code is known, and the `if: always()` step still keeps it.

## What to expect on a runner

A CI runner normally has no coding agent installed, so reach mainly reports the `.env` files and the MCP and project settings of the repository. Run it on a developer machine to see the agent and credential-file findings too. Reach checks one folder and does not walk sub-folders for `.env` files.

To show findings in code scanning instead of keeping a file, see the SARIF workflow in the [reach page](../reach.md#sarif-and-ci) and the [GitHub Action](../github-action.md).
