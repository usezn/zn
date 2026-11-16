# Example: fail a CI job when `scan` finds a secret

This page shows a GitHub Actions job that fails when `zn-gate scan` finds a secret or an injection trap in your files. The folder, the file and every value in it are made up. For every option of the command, see [scan](../cli.md#scan).

`scan` reads a folder or one file. It knows nothing about git: it does not look at the diff, the commit history or the branch, only at the files in the folder you give it. In CI that means the files of the checkout.

## What the scan reads

A folder scan reads only files with these extensions: `.md`, `.txt`, `.prompt`, `.json`, `.yaml`, `.yml`, `.toml`, `.env`, `.pem` and `.key`. That covers docs, configs and prompt templates. Source code is not read by default.

- With the npm package (`npx zn-gate`), add `--all` (or `--code`) to read source files too (`.js`, `.ts`, `.py`, `.sh`, `.html`, `.go`, `.rs`).
- The Python package, which the GitHub Action runs for `scan`, has no `--all` or `--code`.
- `--include .rst,.xml` adds more extensions, and `--exclude fixtures,legacy` skips more folders.

## The Action way

The [zn-gate GitHub Action](../github-action.md) already runs this scan, fails the step on any finding and shows each finding as an annotation. It does not need a separate setup step. Pin it by full commit SHA, and set `version` so the version is explicit:

```yaml
name: Secret scan

on:
  pull_request:

permissions:
  contents: read

jobs:
  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Scan for secrets
        uses: usezn/zn@84f85b2ed5bd938d823bc2521d48044eddb2ad84 # v1.15.0
        with:
          version: '1.15.0'
          mode: scan
          path: '.'
```

`mode: scan` is the default, and `fail-on-threat` defaults to `true`. The [GitHub Action](../github-action.md) page lists every input and output, how to upload the result to code scanning, and what to do to warn without failing.

## The plain `npx` way

If you do not want to use the Action, run the CLI in a step. This job installs only the `zn-gate` package from npm and sends nothing anywhere:

```yaml
name: Secret scan

on:
  pull_request:

permissions:
  contents: read

jobs:
  secret-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 22
      - name: Scan for secrets
        run: npx --yes zn-gate@1.15.0 scan . --format github
```

- The version is pinned in the command (`zn-gate@1.15.0`), so a new release cannot change what your job runs.
- `permissions: contents: read` gives the job nothing else, and `persist-credentials: false` does not leave the token in the checkout.
- `--format github` prints one `::error` annotation per finding, so it shows next to the code in the job log. The default `text` report works too.
- To read source files as well, add `--all` to the command.

## What the job prints

For a folder with a made-up key in `settings.txt`, the scan prints this and exits with `1`, so the job fails:

```text
::error file=settings.txt,line=2,title=Secret found (secret%3Aaws_access_key)::Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.

[zn-gate] Scanned 2 files (0 not scanned). Found 1 secrets and 0 security threats.
```

This is real output of `zn-gate scan . --format github`, run on that folder. The value of the key is never printed. [Scan walkthrough](scan-walkthrough.md) shows the same folder step by step.

## Exit codes

The job fails on any exit code other than `0`:

| Code | Meaning for the job |
|---|---|
| `0` | Nothing found, and every file that matched was read. The job passes. |
| `1` | Something was found, or the path does not exist. The job fails. |
| `2` | The command was used wrongly, for example an unknown `--format`. The job fails. |
| `3` | The result does not cover everything: no file was read, or a file or folder that should have been read was not (2 MiB or larger, cannot be read, not a regular file, or a binary `.key` file). The job fails. |

Findings win: when something was found the code is `1`, whether or not a file was skipped. A scan that read no file never passes, so a wrong `path` cannot turn the job green by accident.

If you accept that some files are not read, add `--allow-partial` to the command. The scan then exits `0` for skipped files, which are still listed in the report. It does not apply when no file was read at all. In the Node version, put the path before the options (`scan . --allow-partial`).

## If a secret is found

Treat the secret as leaked: rotate it first, then remove it from the file. A secret that was ever committed or pushed stays in the git history, and `scan` does not look at the history. See [secrets](../secrets.md) for how to keep the value out of files.

## Where to go next

- [GitHub Action](../github-action.md), every input and output of the Action
- [scan](../cli.md#scan), the reference with every option
- [Exit codes](../exit-codes.md), one page with the code of every command
- [Scan walkthrough](scan-walkthrough.md), `scan` on one small example project
