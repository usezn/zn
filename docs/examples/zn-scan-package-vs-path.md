# Scan a package or a folder: what each one reads and what the exit codes mean

`zn-gate scan` can check two different things: a folder on your disk, with `scan <path>`, and an npm package you have not installed yet, with `scan --package NAME[@VERSION]`. This page puts them side by side, shows two real runs and one refused combination, and lists the exit codes of each. Every name and value in it is made up, except the package `zn-gate@1.15.0`, which is a real published version used as the example package. Every option is described in [scan](../cli.md#scan).

Run every command in your own terminal, not through your agent.

## When to use each

- **Before you add an npm MCP server or an agent skill**, scan the package with `scan --package`. It downloads the package from the npm registry, reads its files and never installs or runs it.
- **For your own project folder**, or for any folder already on your disk, such as a repository you cloned, use `scan <path>`.

The package check is a different feature from [package install check](../package-install-check.md). That one looks at the name an agent is about to install, when the agent runs an install command, and asks you only if the name looks like a well-known package. `scan --package` downloads the package and reads what is inside it.

## Side by side

| | `scan <path>` | `scan --package NAME[@VERSION]` |
|---|---|---|
| Where the files come from | The folder you give, or the current folder if you give none | The npm registry (`ZN_NPM_REGISTRY`, or npmjs.org), unpacked to a temporary folder |
| Files read | Prompt templates, markdown, skills and configs. Source code only with `--all` or `--code` | Every file with a scanned extension in the package, source code included (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx` and the others) |
| Folders skipped by name | `node_modules`, `.git`, `.next`, `.turbo`, `.idea`, `.venv`, `venv`, `__pycache__`, `.eggs`, `dist`, `build`, `target` and `vendor`, plus the names given to `--exclude` | None. No folder is skipped by name, so `dist` and `node_modules` inside the package are read |
| Options accepted | `--format`, `--all` or `--code`, `--include`, `--exclude`, `--include-home`, `--allow-partial` | `--include` and `--format text` (the default) |
| Options refused with exit 2 | None of these | `--format json`, `--format github`, `--exclude`, `--include-home`, `--allow-partial`, and a folder argument |
| Output formats | Text, JSON or GitHub annotations | Text only |
| Installed or run | Nothing | Nothing. The install scripts npm would run are listed for you to read, not run |
| Exit `0` | Nothing found, and every file that matched was read | Nothing found, and every file was read |
| Exit `1` | Something found, or the path does not exist | Something found, or a high-severity finding in the agent-config audit |
| Exit `2` | An unknown `--format`. Nothing is scanned | The package was not scanned: a refused option or folder argument, an unknown name or version, the registry not reachable, a checksum that does not match, a redirect or tarball address outside the registry, or a link or special file in the archive |
| Exit `3` | No file was read, or a file or folder was skipped: a file of 2 MiB or larger, a file that cannot be read, or a folder that cannot be opened | Part of the package was not read: a file of 2 MiB or larger, a file that could not be unpacked (on Windows, some names), or the config audit stopped early. Findings still give `1` |

When something is found, the exit code is `1` even if some files were skipped. The full list of codes for every command is in [exit codes](../exit-codes.md). The Python package has no `--package` yet, see [The Python package](../cli.md#the-python-package).

## Run 1: a folder

The folder `example-project` has two files. The second one holds a made-up AWS-style key. The text is the one from the AWS documentation example, so it is not a real credential.

```text
example-project/
  README.md
  docs/
    notes.md
```

```bash
zn-gate scan ./example-project
echo $?
```

The output, trimmed:

```text
[+]  zn-gate Static Security Audit
Target  : /home/you/example-project
Scope   : Prompt templates, docs, configs (use --code to scan source)
Files   : 2 file(s) queued for audit

Findings (1):
  [x] example-project/docs/notes.md:3 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: Demo setting: AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]
    Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.


-----------------------------------------------------------------------------
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 2
Files Skipped: 0
Status       : Move the secrets out of these files (see "Next" for each one)
-----------------------------------------------------------------------------

1
```

The last line, `1`, is the exit code. The key is shown as `[REDACTED_AWS_KEY]`: the report never prints a matched value.

## Run 2: a package

```bash
zn-gate scan --package zn-gate@1.15.0
echo $?
```

The output, trimmed with `…` where the findings repeat:

```text
[+]  zn-gate Static Security Audit
Target  : npm zn-gate@1.15.0
Scope   : All files (prompts + code)
Files   : 342 file(s) queued for audit

Install scripts (npm runs these when you install it):
  postinstall: node lib/agents/refresh.js
Commands it adds (bin): zn-gate -> bin/cli.js; zn-mcp -> bin/cli.js; zn -> bin/cli.js

Findings (218):
  [x] README.md:25 Threat
    Rule: path:sensitive_file (Targeting sensitive system credentials or environment file)
    Line: 1. `npx -y zn-gate reach` shows what your coding agents can reach on this machine: secrets in your `
…
  [x] lib/vault/help.js:32 Threat
    Rule: path:sensitive_file (Targeting sensitive system credentials or environment file)
    Line: 'Moves the sensitive values of a .env file (default: .env) into the vault and leaves markers in the …
…
-----------------------------------------------------------------------------
Audit Result : FAILED - 7 SECRET(S) FOUND, 211 THREAT(S) FOUND
Files Scanned: 342
Files Skipped: 0
Status       : Review and neutralize detected vectors
-----------------------------------------------------------------------------


Config audit: no findings in npm zn-gate@1.15.0
1
```

This package exits `1` because the report has findings. The lines shown match words such as `.env` and "credentials" in its own README and help text. That is not proof of a problem, but read each finding with its file and line before you add the package. The "Install scripts" and "Commands it adds" lines are the part to read first: they show what `npm install` would run and which commands the package would add.

## A refused combination

`--package` takes the package name, not a folder. Passing a folder as well is refused before anything is downloaded:

```bash
zn-gate scan --package zn-gate@1.15.0 ./example-project
echo $?
```

```text
zn-gate scan: --package scans the package from the registry: leave out the folder argument (./example-project)
2
```

The same exit code `2` comes from an unknown package or version. The message then says that nothing was scanned:

```text
zn-gate scan: zn-gate@0.0.0-nope was not found on the registry. Nothing was scanned.
2
```

## Limits of the package scan

- It reads the files inside the package. It does not read the packages it depends on, unless they are bundled inside it.
- Files of other types, such as binaries, `.wasm` files and files without a scanned extension, are not read.
- It does not run the package, so it cannot show what the code does when it runs.
- If you stop a scan with Ctrl+C, a folder named `zn-scan-pkg-` and a random suffix is left in your system temporary folder. You can delete it. A finished scan removes it.

## See also

- [Scan walkthrough](scan-walkthrough.md): a folder scan, step by step, with the exit codes in CI.
- [Scan a single file](scan-a-single-file.md): the same scan, on one file.
- [Packages your agent installs](package-install-check-walkthrough.md): the name check for installs.
- [Command line reference: scan](../cli.md#scan): every option of `scan`.
