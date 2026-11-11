# Example: scan only the files a branch changes

In a large repository, `zn-gate scan .` reads every prompt, markdown, config and secret-bearing file in the tree. On every CI run that gets slow, and most of the files have not changed. This page shows how to scan only the files that a branch changes against its base branch, and what `scan` does and does not support for that.

Every command and output below was run against a small throwaway repository with made-up content. The options of `scan` are in the [command reference](../cli.md#scan), the walkthrough is in the [scan walkthrough](scan-walkthrough.md), and the pre-commit hook for staged files is in [scan before each commit](pre-commit-scan.md).

## What `scan` accepts

- **One path per call.** The npm version reads the first path and ignores the others without a warning. The Python version stops with an error:

  ```bash
  zn-gate scan docs/guide.md src/app.js
  ```

  ```text
  # npm version: "Files Scanned" counts docs/guide.md only, and src/app.js is not read.
  # Python version:
  zn-gate: error: unrecognized arguments: src/app.js
  ```

  The Python command exits `2`. Give `scan` one path per call, as the script below does.

- **No list of files.** There is no `--staged`, `--changed` or `--files` option, and `scan` does not read a list from standard input. An unknown option exits `2`:

  ```text
  zn-gate: unknown option "--staged". The options of zn-gate scan are --format, --include, --exclude, --code, --all, --allow-partial, --include-home, --package.
  ```

- **A `--` before the path** is accepted, so a file name that starts with `--` is read as a path. The script uses `--` for every file name.

- **A file you name is read whatever its extension is,** and whatever folder it is in. A changed file inside `node_modules` or `dist` is read when you name it. Folders are only skipped when `scan` walks into them.

## What a folder scan skips

When you give `scan` a folder, it walks it and skips:

- `node_modules`, `.git`, `.next` and `.turbo`. These are skipped without a report.
- `dist`, `build`, `.idea`, `.venv`, `venv`, `__pycache__` and `.eggs`. These are skipped and listed under "Directories not scanned".
- `vendor` and `target` are skipped only when a manifest or build file sits next to them (for example `go.mod` or `Cargo.toml`); otherwise they are read.

The Python version skips the same names.

Inside the folders it walks, it reads only some file types. The npm version reads `.md`, `.txt`, `.prompt`, `.json`, `.yaml`, `.yml`, `.toml`, `.env*`, `.pem` and `.key`. Source code (`.js`, `.ts`, `.py`, `.sh`, `.html`, `.go`, `.rs`) is read only with `--code`. The Python version also reads `.js`, `.ts` and `.py` in a folder without that flag, so the two versions can report different totals for the same folder.

A file of 2 MiB or larger is not read. That makes the exit code `3` unless you pass `--allow-partial`, and `--allow-partial` does not help when no file is read at all. Keep this in mind for a large changed file: see the note after the script.

## The script: scan the files a branch changes

Save this as `scan-changed.sh` at the root of the repository, or in your CI job. It lists the files that the branch adds, copies, modifies or renames against the base branch, NUL-separated so that names with spaces are safe, and scans each one by name:

```bash
#!/usr/bin/env bash
# Scan only the files that the current branch changes against a base branch.
# Usage: scan-changed.sh [base]     (default base: origin/main)
# Exit: 0 when every changed file is clean, 1 when a file has a finding, 3 when a file was not read.
# The highest exit code of the files wins. Run it from the root of the repository.
set -u

base="${1:-origin/main}"
list=$(mktemp) || exit 2
trap 'rm -f "$list"' EXIT

# NUL-separated, so file names with spaces or newlines are safe.
if ! git diff --name-only --diff-filter=ACMR -z "$base...HEAD" > "$list"; then
  echo "scan-changed: could not list the changed files against $base. Nothing was scanned." >&2
  exit 2
fi

worst=0
count=0
while IFS= read -r -d '' file; do
  count=$((count + 1))
  zn-gate scan -- "$file"
  rc=$?
  if [ "$rc" -gt "$worst" ]; then
    worst=$rc
  fi
done < "$list"

if [ "$count" -eq 0 ]; then
  echo "scan-changed: no added, copied, modified or renamed files against $base."
fi
exit "$worst"
```

Run it from the repository root:

```bash
bash scan-changed.sh origin/main
```

Notes on the script:

- The base branch must exist in the clone, because `git diff base...HEAD` needs it. In GitHub Actions, check out with `fetch-depth: 0`, or fetch the base branch first.
- If the base cannot be found, the script stops with exit `2` and scans nothing. An empty list is not an error: the script says so and exits `0`.
- It starts one `zn-gate` process per file, so each result is reported on its own. It is slower than one scan of the folder when many files change.
- It calls `zn-gate`, the npm package (`npm install -g zn-gate`).
- Do not add `--allow-partial` to the `zn-gate` line for this: when the file you name is the only one, `scan` reads nothing and still exits `3`. A changed file of 2 MiB or more therefore fails the job. If you have decided to skip such files, leave them out of the list in your pipeline and write that decision down.

## What the runs showed

Each row is one run of the script against a branch, with the base `main`. The demo repository had a secret made of the AWS documentation example key, a clean source file, a file in a folder with a space in its name, and a 2 MiB filler file.

| Branch | Changed files | Exit code | Result |
|---|---|---|---|
| `probe-clean` | `src/app.js` | `0` | `PASSED - NO THREATS DETECTED` |
| `probe-finding` | `docs/guide.md` (with the example key) | `1` | `FAILED - 1 SECRET(S) FOUND` |
| `feature` | six files, including the 2 MiB file | `3` | `Not scanned (1): docs/big.json (2 MiB or larger)` |
| any branch, base missing | (none) | `2` | `could not list the changed files against <base>. Nothing was scanned.` |

With an empty diff, the script prints `no added, copied, modified or renamed files against <base>.` and exits `0`.

If you build the same list with `xargs -0` instead of the loop, add `-r` (`xargs -0 -r -n1`). Without it, GNU `xargs` runs the command once with no file names when the list is empty, and `zn-gate scan --` then scans the whole repository. Tested: an empty input printed the command line without `-r` and printed nothing with it.

## The pre-commit hook does not pass staged files

The `zn-gate-scan` hook in the repository's `.pre-commit-hooks.yaml` runs `zn-gate scan` with no path and `pass_filenames: false`. When a matching file is staged, it scans the whole repository, not the staged files. For a hook that checks only the staged files, use the script in [scan before each commit](pre-commit-scan.md).

## More

- [`scan` in the command reference](../cli.md#scan)
- [Exit codes](../exit-codes.md#scan-and-review)
- [Scan before each commit](pre-commit-scan.md)
- [CI secret scan gate](ci-secret-scan-gate.md)
