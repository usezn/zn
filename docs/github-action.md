# zn-gate GitHub Action: audit agent configs and scan prompts in CI

The zn-gate Action checks a repository on every pull request for the two things that make a coding agent unsafe to open it:

- **Audit** (`mode: audit`): runs [`zn audit`](audit.md). It reads what your coding agents are configured to trust (`.claude/`, `.mcp.json`, `.codex/`, `.cursor/`, hooks, `AGENTS.md` / `CLAUDE.md`, plugins and skills) and reports commands that would run, servers that would start, where requests would go and instructions an agent would follow. It runs nothing from the repository.
- **Scan** (`mode: scan`, the default): runs `zn-gate scan`, which looks for prompt-injection traps and leaked secrets in prompts, tool definitions and config files.
- `mode: both` runs the two.

The Action installs the published `zn-gate` packages at an exact version and runs on the runner only. It sends nothing anywhere, needs no account and collects no telemetry.

## Minimal workflow

Audit every pull request and show the findings in code scanning:

```yaml
name: AI agent config audit

on:
  pull_request:

permissions:
  contents: read

jobs:
  zn-gate-audit:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write   # only for the SARIF upload
      actions: read            # private repositories only, for upload-sarif
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Audit agent configs
        id: zn
        uses: usezn/zn@<commit-sha> # vX.Y.Z
        with:
          mode: audit
          format: sarif
      - name: Upload SARIF
        if: ${{ !cancelled() && steps.zn.outputs.sarif-file != '' }}
        uses: github/codeql-action/upload-sarif@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
        with:
          sarif_file: ${{ steps.zn.outputs.sarif-file }}
```

Replace `<commit-sha>` with the full commit SHA of the release you want and `vX.Y.Z` with its name; the [releases page](https://github.com/usezn/zn/releases) lists both. Pin by commit SHA, not by tag or branch: a tag can be moved. The workflow files in [`examples/github-action/`](../examples/github-action/) show the same with every input.

### Permissions

- `contents: read` is all the Action needs. Set it at the top of the workflow so the job gets nothing else.
- `security-events: write` only for the job that uploads SARIF to code scanning. Without the upload step (for example with `format: github`), leave it out.
- `actions: read` only in private repositories, which `upload-sarif` needs.

On pull requests from forks, GitHub may not allow the SARIF upload. The audit still runs and its result still sets the status of the job.

## Which version runs

The `version` input is the exact `zn-gate` version that gets installed; ranges and `latest` are refused. When you leave it out, you get the version that the pinned release of the Action sets as its default, so pinning the Action by SHA also pins what runs. Set `version` when you want to move the two separately. We recommend setting `version` in every workflow: from 1.13.0 on, each release of the Action defaults to its own `zn-gate` version, but the 1.12.0 release of the Action still defaults to 1.10.0. For a stronger check, set `package-sha256` (the hash of the PyPI wheel, used by `scan`) and `npm-integrity` (the `sha512-...` integrity of the npm tarball, used by `audit`): the install fails when the downloaded file differs.

`audit` needs `zn-gate` 1.6.0 or later. With an older version, `mode: both` runs the scan only and prints a warning, and `mode: audit` fails.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `mode` | `scan` | `scan`, `audit` or `both`. |
| `version` | set by the release | Exact `zn-gate` version to install. |
| `path` | `.` | Path to check, relative to the workspace. `audit` needs a directory. |
| `fail-on-threat` | `true` | Fail the step on findings. `false` reports only. |
| `allow-partial` | `false` | Scan only: `true` keeps the step green when some files or folders were not read (2 MiB or larger, cannot be read, not a regular file, binary `.key` file). They are still listed. A scan that read no file at all still fails. Needs `zn-gate` 1.14.0 or later: with an older `version` the step stops with an error. |
| `severity-threshold` | `high` | Audit only: lowest severity that fails the step when `fail-on-threat` is `true` (`critical`, `high`, `medium`, `low`). The scan has no severities: any finding fails. |
| `fail-on` | empty | Audit only: lowest severity that fails the step (`low`, `medium`, `high`, `critical`, `none`). When set, it overrides `fail-on-threat` and `severity-threshold`. |
| `agents` | empty (all) | Audit only: comma-separated agents to audit, as `zn audit --agents` takes them. |
| `format` | `github` | `github` (inline annotations), `text`, `json` or `sarif`. |
| `sarif-file` | empty | With `format: sarif`: where to write the file, inside the workspace or the runner temp directory. Empty writes `zn-gate.sarif` in a new directory under the runner temp directory. |
| `package-sha256` | empty | SHA-256 of the PyPI wheel for `version`. |
| `npm-integrity` | empty | `sha512-...` integrity of the npm tarball for `version`. |

Outputs:

| Output | Meaning |
|---|---|
| `sarif-file` | Path of the SARIF file (`format: sarif` only); empty if none was written. |
| `scan-exit-code` | Exit code of the scan: `0` clean, `1` findings, `2` error, `3` no file was read, or a file or folder was not read and `allow-partial` is not `true` (zn-gate 1.14.0 and later); empty if it did not run. The step then fails with its own message and, with `format: sarif`, the report is still written. |
| `audit-exit-code` | Exit code of the audit: `0` clean, `1` findings at or above the threshold, `2` error; empty if it did not run. |

## What the scan does not read

The scan lists what it leaves out, so a gap never goes unnoticed. Files it does not read (binary files, files of 2 MiB or more) and directories it does not enter (`build`, `dist`, `vendor`, `target`) appear as notices in the workflow run, as a count in the text output, and as `skipped` and `skipped_dirs` in the JSON output. Dependency stores and caches such as `node_modules`, `.git` and `.venv` are skipped without a notice. Test directories (`test`, `tests`, `__tests__`) are read, because fixtures there can hold real secrets. The Node and Python scans skip exactly the same directories. A directory named `target` is skipped only when a `Cargo.toml`, `pom.xml`, Gradle or sbt file sits next to it, and `vendor` only next to `go.mod`, `composer.json`, `Gemfile` or `Cargo.toml`. The directory you pass to the scan is always read, whatever its name. A name you pass with `--exclude` is skipped everywhere and is not listed.

## Read the results in code scanning

With `format: sarif` and the upload step, the findings appear in your repository under **Security** > **Code scanning**, one alert per finding, with the rule ID, the file and the line, and the evidence with any secret value hidden. On a pull request, GitHub also annotates the changed lines. The audit and the scan are separate runs (categories `zn-gate/audit/` and `zn-gate/scan/`), so you can filter by tool. [audit.md](audit.md) lists each audit rule and how to fix it.

Code scanning needs a public repository, or GitHub Code Security on a private one. Without it, use `format: github` (the default): the findings show as annotations in the workflow run and on the pull request, and no `security-events` permission is needed.

## Pull request example with common inputs

This workflow checks every pull request with both the audit and the scan. It fails the step on audit findings of severity `high` or above, and on any scan finding. It uses only inputs that `action.yml` defines, and needs no code scanning permissions because `format: github` shows findings as annotations.

```yaml
name: zn-gate

on:
  pull_request:

permissions:
  contents: read

jobs:
  zn-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Audit agent configs and scan for secrets
        uses: usezn/zn@746be20f3276ab0d589f2d6df941b5d31a5396d8 # v1.13.1
        with:
          version: '1.13.1'
          mode: both
          path: '.'
          format: github
          fail-on-threat: 'true'
          severity-threshold: 'high'
```

See [Inputs](#inputs) for every option.

## Warn without failing the build

To see the findings on a pull request without blocking it, set `fail-on-threat: 'false'`. The step then ends green even when something is found, and with the default `format: github` each finding shows as an annotation in the workflow run and on the changed lines of the pull request.

```yaml
name: AI agent config audit (warn only)

on:
  pull_request:

permissions:
  contents: read

jobs:
  zn-gate-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Audit agent configs (report only)
        uses: usezn/zn@746be20f3276ab0d589f2d6df941b5d31a5396d8 # v1.13.1
        with:
          version: '1.13.1'
          mode: audit
          format: github
          fail-on-threat: 'false'
```

Always set `version` to the same release as the pinned Action. In the 1.12.0 Action the default `version` is still 1.10.0 (an older release), so do not rely on it.

Both modes also check the MCP config files of the repository (such as `.mcp.json`, `.cursor/mcp.json` and `.vscode/mcp.json`) for keys and passwords written in plain text. The value is never printed.

Releases up to and including 1.13.1 do not have this check. It comes in a later release, so the example above, which pins 1.13.1, does not show these annotations yet. Once the Action pins that release, `scan` reports the finding as `secret:mcp_config` and `audit` as `ZNA011`. Until then, both modes only report keys with a known format (for example an AWS access key) in these files, under the general secret rules.

Each finding is an error annotation on the file and line. The audit's message names the key; the scan's message does not, and suggests a vault name to use instead. With `fail-on-threat: 'false'` the annotation is still an error (red), but the step ends green. A warn-mode scan of a `.mcp.json` with a key in an `env` block shows this, shortened:

```text
Secret found (secret:mcp_config)   .mcp.json, line 6
Next: run npx -y zn-gate secret set MCP_API_KEY to store the value in the local vault ... and rotate the value if the file was ever committed or shared.
```

The audit shows, for the same key:

```text
Agent config audit (ZNA011)   .mcp.json, line 6
Secret value in an agent file: A credential is written in plain text in this MCP server configuration (environment variable API_KEY).
```

Notes:

- The Action does not write a job summary. The findings appear as annotations and in the log of the run. GitHub shows at most 10 error annotations and 10 warning annotations per step, so with many findings open the log of the run to see them all.
- To keep a list of findings instead, use `format: sarif` with the upload step and the permissions from the [minimal workflow](#minimal-workflow), and keep `fail-on-threat: 'false'`. They appear as alerts under **Security** > **Code scanning** (public repositories, or private ones with GitHub Code Security).
- In report-only mode the exit codes stay `0`, so do not use `audit-exit-code` or `scan-exit-code` to detect findings.
- When you are ready to block, remove `fail-on-threat` (the default is `true`, which fails on findings at or above `severity-threshold`, `high` by default), or set `fail-on` to the lowest severity that should fail.

## Badge

Show that the check runs, with the status badge of your own workflow (replace `OWNER`, `REPO` and the file name):

```markdown
[![zn-gate audit](https://github.com/OWNER/REPO/actions/workflows/zn-gate-audit.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/zn-gate-audit.yml)
```

## Run the same check on your machine

```bash
npx -y zn-gate audit .
```

## Related

- [`zn audit`](audit.md): what it checks and every rule.
- [Action inputs in the README](../README.md#github-action).
