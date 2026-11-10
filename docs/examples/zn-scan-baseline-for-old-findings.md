# Triage the old findings of a legacy repo with `zn-gate scan`

You inherit a repository with years of prompt files, docs and config. The first `zn-gate scan` reports many findings, and some of them are old, known and not urgent. This page shows how to work through them with the options that exist today.

zn-gate `scan` has **no baseline file and no ignore list**. Nothing records that you accepted a finding, so every run reports every finding it still reads. The way to triage is to:

1. save the full list once,
2. decide which folders are really in scope,
3. fix the findings, and
4. run the scan again and check the exit code.

All values in this page are made up. The sample output comes from a small test folder with a fake key (`AKIAIOSFODNN7EXAMPLE`, the example key from AWS's own documentation). The paths are shortened.

## What the scan reads

By default `scan` reads these file types: `.md`, `.txt`, `.prompt`, `.json`, `.yaml`, `.yml`, `.toml`, `.env`, `.pem` and `.key`. Source code is not read unless you add `--code` (or `--all`), which adds `.js`, `.ts`, `.py`, `.sh`, `.html`, `.go` and `.rs`. `--include .rst,.xml` adds more extensions. (`packages/zn-gate/bin/cli.js`, lines 502 to 503 and 507 to 511.)

Some folders are skipped by name:

- Silently, without a line in the report: `node_modules`, `.git`, `.next` and `.turbo` (`packages/zn-gate/lib/prune.js`, `SILENT` at lines 28 to 33, and `SCAN_DIRS` at lines 38 to 41).
- With a line in "Directories not scanned": `dist`, `build`, `.venv`, `venv`, `__pycache__`, `.eggs` and `.idea`, with a reason such as `skipped by name: build output`. A folder named `target` is skipped only next to a build file such as `Cargo.toml`, and `vendor` only next to a package file such as `go.mod` (`prune.js`, `MARKERS` at lines 19 to 22).

Any other folder, such as `out` or `.cache`, is read.

The folder you pass is always read, whatever its name. Folders skipped by name do not make the result incomplete, so they do not give exit `3` (`cli.js`, line 747).

## 1. Save the full list once

```bash
npx -y zn-gate scan ./legacy-repo --format json > scan-legacy.json
echo $?
```

On a repository with findings the exit code is `1`. The JSON file has one entry per finding, with the file, the line, the rule and a `content` field. Matched values are never printed: the `content` field shows the line with the secret replaced by a marker such as `[REDACTED_AWS_KEY]`.

Sample output from the test folder, with the fields you will use (`--format json`, shortened):

```json
{
  "total_files": 4,
  "total_skipped": 0,
  "total_skipped_dirs": 0,
  "total_threats": 2,
  "total_secrets": 2,
  "incomplete": false,
  "threats": [
    {
      "file": "docs/deploy.md",
      "line": 3,
      "rule": "secret:aws_access_key",
      "type": "secret_leak",
      "content": "export AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]",
      "next_step": "Next: run npx -y zn-gate secret set NAME ..."
    }
  ],
  "skipped": [],
  "skipped_dirs": []
}
```

The `total_threats` field counts every finding; `total_secrets` counts only the ones of type `secret_leak`. The other findings (type `injection`) are prompt-level findings. (`packages/zn-gate/bin/cli.js`, lines 780 to 797.)

## 2. See what the findings have in common

Use any JSON tool. With `jq` (the file is the one from step 1):

```bash
jq '{total_threats, total_secrets, incomplete}' scan-legacy.json
jq -r '.threats[] | "\(.rule)\t\(.file)"' scan-legacy.json | sort | uniq -c | sort -rn
```

The second command counts the findings per rule and file. Often a few files hold most of the findings, and a few rules repeat. That is the order to work in.

## 3. Narrow the scope only with a reason

`--exclude` skips folders by name, at any depth. The name must match the folder name exactly:

```bash
npx -y zn-gate scan ./legacy-repo --exclude fixtures,legacy --format json > scan-legacy.json
```

Two things to know before you use it:

- An excluded folder is not read and is **not listed** anywhere in the report, so its findings disappear from the record too. Exclude a folder only when you know it is not used (for example a copy of old code that nothing loads). Do not exclude a folder just to make the count smaller. (`cli.js`, line 537.)
- `--exclude` takes folder names, not paths, and it does not apply to the folder you pass.

In the test folder, `--exclude fixtures,legacy` removed the finding in `fixtures/sample.env` and kept the one in `docs/deploy.md`, so the exit code stayed `1`.

## 4. Read the exit code

| Exit code | Meaning |
|---|---|
| `0` | Nothing found, and every file and folder that should be read was read. |
| `1` | At least one finding. Also the code when the path does not exist. |
| `2` | Wrong use: an unknown option (such as `--baseline`), or a `--format` other than `text`, `json` or `github`. |
| `3` | Not a clean result: a file was not read (for example a file of 2 MiB or larger), a folder could not be opened, or no file was read at all. |

Source: `cli.js`, lines 750 to 756 (the exit code rule), 583 to 584 (path does not exist), 589 to 590 (format), and 1037 to 1058 (unknown options). An unknown option gives this message, for example with `--baseline`:

```
zn-gate: unknown option "--baseline". The options of zn-gate scan are --format, --include, --exclude, --code, --all, --allow-partial, --include-home, --package.
```

Folders skipped by name, such as `dist`, do not give exit `3`. Files and folders that could not be read do (`docs/cli.md`, the scan section).

`--allow-partial` accepts the files and folders that were not read: exit `0`, and they are still listed. It does not help when no file was read at all, which stays exit `3`. In the test folder, a folder with one clean file and one file of 2 MiB or larger gave exit `3` by default and exit `0` with `--allow-partial`. Use it only when you have looked at the skipped files and decided they do not matter.

## 5. Fix the findings

For each secret, the report gives a next step. For the AWS key in the test folder it is:

```
Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.
```

(`cli.js`, `secretNextStep`, line 106 onward.) In practice:

1. Move the value into the vault, or replace it with a placeholder.
2. If the value was committed or shared, rotate it at the provider. Removing it from the file does not undo a leak.
3. Remove the value from the file yourself. zn-gate does not edit your files during a scan.

## 6. Check again

Run the same command as in step 1 and compare the numbers:

```bash
npx -y zn-gate scan ./legacy-repo --format json > scan-legacy-after.json
jq '.total_threats' scan-legacy.json scan-legacy-after.json
```

A fixed finding is simply gone from the new list. A finding you decided to keep for now will come back on every run, because there is nothing to mark it as accepted. Write that decision in your team's notes, with the file and the reason.

## Before you add the scan to CI

Run the triage first, and add the gate only when the list is clean or every remaining case is written down. The gate job and its exit codes are in [CI secret scan gate](ci-secret-scan-gate.md). The [scan reference](../cli.md#scan) lists every option.

## Related pages

- [Scan walkthrough](scan-walkthrough.md): one small project, from the run to each exit code.
- [Reading a scan finding](reading-a-scan-finding.md): what each line of a finding means.
- [Scan a single file](scan-a-single-file.md): scan one file instead of a folder.
