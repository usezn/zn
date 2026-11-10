# Example: scan before each push

A git pre-push hook that runs `zn-gate scan` on the files that a push adds or changes, and stops the push when it finds a secret or an injection trap, or when it cannot read a file. The script below uses no network and holds no secrets. Every option of `scan` is in the [command reference](../cli.md#scan). For the hook that runs before each commit, read [scan before each commit](pre-commit-scan.md).

Run every command in your own terminal, not through your agent. All values in this page are made up.

## What the hook checks

Git runs a pre-push hook once for each branch you push, and gives it one line per branch on standard input: `<local ref> <local sha> <remote ref> <remote sha>`. The hook uses those lines:

- **A branch that already exists on the remote:** it checks the files that differ between the commit the remote has and the commit you push.
- **A new branch:** the remote has no commit to compare with, so it checks every file of the branch. On a large repository this takes longer.
- **A deleted branch:** nothing is checked, because no commit is sent.

It reads the content of each commit (what the push sends), not the files on disk. Each file is written under its own name in a temporary folder, and `zn-gate scan` checks that one file. A named file is read whatever its extension, which is why source code is checked too (see [troubleshooting, section 17](../troubleshooting.md#17-scan-reads-no-source-code)).

## The hook

Save this as `.git/hooks/pre-push` in your repository, then make it executable with `chmod +x .git/hooks/pre-push`:

```bash
#!/usr/bin/env bash
# Pre-push hook: scan the files that this push adds or changes with zn-gate.
# Git sends one line per ref on standard input:
#   <local ref> <local sha> <remote ref> <remote sha>
# It checks the content of the commit being pushed, not the files on disk.
# It runs on your computer and needs no network.

zero=0000000000000000000000000000000000000000

if ! command -v zn-gate >/dev/null 2>&1; then
  echo "pre-push: zn-gate is not installed, so nothing was scanned. The push was stopped." >&2
  echo "Install it once with: npm install -g zn-gate" >&2
  exit 1
fi

work=$(mktemp -d) || { echo "pre-push: could not create a temporary folder. The push was stopped." >&2; exit 1; }
trap 'rm -rf "$work"' EXIT
refs="$work/refs"
list="$work/list"
tree="$work/tree"
failed=0

# Keep the refs in a file first, so the commands below cannot read from git's input.
cat > "$refs" || exit 1

while read -r local_ref local_sha remote_ref remote_sha; do
  # Deleting a branch sends no commit, so there is nothing to check.
  if [ "$local_sha" = "$zero" ]; then
    continue
  fi
  if [ "$remote_sha" = "$zero" ]; then
    # New branch: the remote has no commit to compare with, so check every file in it.
    if ! git ls-tree -r -z --name-only "$local_sha" > "$list"; then
      echo "pre-push: could not list the files of $local_ref. The push was stopped." >&2
      exit 1
    fi
  else
    # Existing branch: check the files that differ from the commit the remote has.
    if ! git diff --name-only --diff-filter=ACMR -z "$remote_sha" "$local_sha" > "$list"; then
      echo "pre-push: could not list the changed files of $local_ref. The push was stopped." >&2
      exit 1
    fi
  fi

  while IFS= read -r -d '' file; do
    # Write the content of that commit under the same path, and check that copy.
    rm -rf "$tree"
    if ! mkdir -p -- "$tree/$(dirname -- "$file")" || ! git cat-file blob "$local_sha:$file" > "$tree/$file"; then
      echo "pre-push: could not read $file from the commit being pushed. The push was stopped." >&2
      failed=1
      continue
    fi
    if ! (cd "$tree" && zn-gate scan "./$file"); then
      failed=1
    fi
  done < "$list"
done < "$refs"

if [ "$failed" -ne 0 ]; then
  echo "pre-push: zn-gate found something, or could not read a file. The push was stopped." >&2
  exit 1
fi
exit 0
```

## What happens

A push whose files are clean runs the scan and goes through. The report of each file ends like this (the path is in a temporary folder, so it differs on your computer):

```text
Audit Result : PASSED - NO THREATS DETECTED
Files Scanned: 1
Files Skipped: 0
```

A push with a made-up AWS key in `deploy.txt` is stopped. The finding shows the line with the value hidden:

```text
[x] deploy.txt:2 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: aws_access_key_id = [REDACTED_AWS_KEY]
Audit Result : FAILED - 1 SECRET(S) FOUND
pre-push: zn-gate found something, or could not read a file. The push was stopped.
```

Read the `Next:` line of the finding. It tells you how to move the value into the local vault. Then commit the change and push again.

A file of 2 MiB or more is not read. The report says `NOTHING SCANNED` and the push stops, because the result does not cover that file:

```text
Audit Result : NOTHING SCANNED
Not scanned (1):
  big.txt (2 MiB or larger)
```

## Exit codes

The hook checks one file at a time, and stops the push when `zn-gate scan` returns anything other than `0` (see [the reference](../cli.md#scan) and [exit codes](../exit-codes.md)):

| Code | Meaning for one file | What the hook does |
|---|---|---|
| `0` | Nothing found, and the file was read. | Goes on. |
| `1` | Something was found, or the path does not exist. | Stops the push. |
| `2` | `zn-gate` did not accept the command. The hook passes no options, so read the message it printed. | Stops the push. |
| `3` | The file was not read: 2 MiB or larger, cannot be read, not a regular file, or a binary `.key` file. | Stops the push. |

`--allow-partial` turns `3` into `0`, but only when some files were read. It does not apply when no file was read at all, which is the case for a single file the scan skipped (the example above still exits `3`). The hook does not pass it. Add it only if you accept that the file was not checked.

Do not look for a way around a stopped push. Read the message, fix the file or the finding, and push again.

## Limits

- The hook checks the final content of each changed file. A commit that held a secret, followed by a later commit that removed it, is not checked, but the earlier commit is still pushed.
- For a new branch, every file of the branch is checked, so the push can take a while on a large repository.

## Related

- [Scan before each commit](pre-commit-scan.md)
- [Scan one file](scan-a-single-file.md)
- [Exit codes](../exit-codes.md)
- [Command reference: scan](../cli.md#scan)
