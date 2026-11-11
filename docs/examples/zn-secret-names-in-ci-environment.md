# Example: read a secret in CI from the CI platform, under the name you use locally

The zn vault is not for CI. It is a store on one computer: a person unlocks it in a terminal or a system dialog, and confirms each first use of a secret. A CI runner has no vault to unlock and no one to confirm anything, so do not keep CI secrets in the vault.

In CI, keep each secret in the CI platform's own secret store, and pass it to the job as an environment variable. Give that variable the same name your program already reads on your machine, so the same code works in both places.

All names and values here are made up. For the vault itself, read [Keep secrets out of your coding agent](../secrets.md). For the CI rules for agents, read [Coding agents in CI](../agents-in-ci.md).

## What zn does in CI

These points were checked on the code of version 1.15.0:

- `zn-gate run --secrets EXAMPLE_TOKEN -- <command>` stops before the command starts when there is no unlocked vault. It prints that the vault is locked and exits with `1`. Nothing is passed to the command.
- `zn-gate run -- <command>` with no `--secrets` starts the command with the environment the job already has. It does not read the vault.
- `zn-gate scan` and `zn-gate audit` read files. They do not read the environment of the job or the logs of a run, so they cannot tell whether a value is printed at run time.

## Do not put the vault passphrase in CI

Never store the vault passphrase in a CI secret, in a variable or in a workflow file, and never try to unlock the vault from a workflow. If a job needs a value, store that value as a CI secret.

## The same name on your machine and in CI

On your machine, store the value in the vault under the name the program reads, and allow the one command that may use it:

```bash
npx -y zn-gate secret set EXAMPLE_TOKEN --command npm
npx -y zn-gate run --secrets EXAMPLE_TOKEN -- npm test
```

`secret set` asks for the value at a hidden prompt. Type a fake value such as `example-not-a-real-token-1234`. The program reads the variable `EXAMPLE_TOKEN` from its environment, and it does not matter whether `run` or the CI job put it there.

In the repository, add the same name as an Actions secret: open the repository settings, then **Secrets and variables**, then **Actions**, and create `EXAMPLE_TOKEN`.

## A minimal GitHub Actions job

The action versions are pinned by full commit SHA, the same ones the [CI secret scan example](ci-secret-scan-gate.md) uses.

```yaml
name: Tests

on:
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Run the tests with the secret
        env:
          EXAMPLE_TOKEN: ${{ secrets.EXAMPLE_TOKEN }}
        run: npm test
```

- The `env:` block is on the test step only, so only that step receives the value. GitHub fills in `${{ secrets.EXAMPLE_TOKEN }}`, not zn.
- Pull requests from forks do not receive repository secrets, so this step gets no value for them.
- Do not print the variable, for example with `echo`. GitHub hides the values it knows in the log, but only on a best-effort basis.

## Check the repository for secrets committed by mistake

Add two steps to the job, after the checkout, to catch a secret that was written into a file:

```yaml
      - name: Scan the files for secrets
        run: npx --yes zn-gate@1.15.0 scan . --format github
      - name: Audit the agent configuration
        run: npx --yes zn-gate@1.15.0 audit . --fail-on high
```

- `scan` reads the files of the checkout, including workflow files (`.yml`), and fails the step when it finds a secret value written in them. It prints the rule and the line number, never the value. It does not read the git history, so a secret that was committed earlier is still in it.
- `audit` reviews the agent configuration of the repository and fails the step at `high` or above. See [audit](../audit.md) for what it checks.
- Neither command flags `echo "${{ secrets.EXAMPLE_TOKEN }}"` or `echo "$EXAMPLE_TOKEN"` in a workflow. Review those lines yourself.
- The scan output may suggest `zn-gate secret set`. That advice is for your own machine. In CI, store the value as a CI secret instead.

If a value was ever committed or printed, rotate it at its provider first, then remove it from the files. Removing it does not clean the git history or old logs. See [If a secret is found](ci-secret-scan-gate.md#if-a-secret-is-found).

## Related

- [Coding agents in CI](../agents-in-ci.md): what zn-gate does and does not protect in a workflow
- [CI secret scan](ci-secret-scan-gate.md): the scan job in full, with the Action and with `npx`
- [GitHub Action](../github-action.md): every input and output of the Action
- [Keep secrets out of your coding agent](../secrets.md): the vault, markers and `zn run`
