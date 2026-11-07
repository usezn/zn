# Example: scan before each commit

A git pre-commit hook that runs `zn-gate scan` on the files you are about to commit, and stops the commit when it finds a secret or an injection trap. The script below uses no network and holds no secrets. Every option of `scan` is in the [command reference](../cli.md#scan); a first run on a small folder is in the [scan walkthrough](scan-walkthrough.md).

Run every command in your own terminal, not through your agent.

## What `scan` looks at

`scan` is a static check of files. It looks through prompt templates, markdown, skills and configs for injection traps and secrets, and it never prints a matched value. It does not look at git: it knows nothing about staged changes or history.

Two details matter for a hook:

- When you scan a folder, it reads files with these extensions: `.md`, `.txt`, `.prompt`, `.json`, `.yaml`, `.yml`, `.toml`, `.env`, `.pem` and `.key`, plus `.env*` files. Source code (`.js`, `.ts`, `.py`, `.sh`, `.html`, `.go`, `.rs`) is only read with `--all`.
- When you name one file, it reads that file whatever its extension. `scan` takes one path at a time.

So the hook below scans each staged file by name. That way it covers source code as well, without scanning the whole project on every commit.

It reads the file as it is on disk, which is what you staged unless you changed it after `git add`.

## The hook

Save this as `.git/hooks/pre-commit` in your repository:

```bash
#!/usr/bin/env bash
# Pre-commit hook: scan the files you are about to commit with zn-gate.
# It runs on your computer and needs no network.

if ! command -v zn-gate >/dev/null 2>&1; then
  echo "pre-commit: zn-gate is not installed, so nothing was scanned." >&2
  echo "Install it once with: npm install -g zn-gate" >&2
  exit 1
fi

failed=0
# The files in this commit (added, copied, modified, renamed), one name at a time.
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  if ! zn-gate scan "./$file"; then
    failed=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

if [ "$failed" -ne 0 ]; then
  echo "pre-commit: zn-gate found something, or could not read a file. The commit was stopped." >&2
  exit 1
fi
exit 0
```

Then make it executable:

```bash
chmod +x .git/hooks/pre-commit
```

The hook uses the installed `zn-gate`, not `npx`, so it never downloads anything while you commit. If `zn-gate` is missing it stops the commit and says so, instead of letting an unscanned commit through.

## What happens

A commit that contains a clean file runs the scan and goes through. For a file with a made-up credential in it, `settings.txt`:

```text
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
```

the commit is stopped, and you see the report (example output):

```text
Findings (1):
  [x] settings.txt:1 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: aws_access_key_id = [REDACTED_AWS_KEY]
    Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.

-----------------------------------------------------------------------------
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 1
Files Skipped: 0
Status       : Move the secrets out of these files (see "Next" for each one)
-----------------------------------------------------------------------------

pre-commit: zn-gate found something, or could not read a file. The commit was stopped.
```

Take the value out of the file, use the marker the `Next` line describes, and commit again.

`scan` exits `0` when it found nothing and read the file, `1` when it found something, and `3` when it could not read the file (for example, a file of 2 MiB or larger). The hook treats every code other than `0` as a stop. See [the four exit codes](scan-walkthrough.md#the-four-exit-codes).

## Good to know

- **Skip it once:** `git commit --no-verify` skips every pre-commit hook. Use it only when you have looked at the finding yourself.
- **One person only:** files in `.git/hooks` are not part of the repository, so each person who wants the check installs the hook on their own computer. To share a hook with your team, use a hooks folder inside the project with `git config core.hooksPath` or a tool such as pre-commit; this page does not cover them.
- **Whole folder instead:** if you only want to scan the files that `scan` reads by default, a hook that runs `zn-gate scan .` and passes on exit `0` is the shortest version. It scans every matching file in the project, staged or not, so it gets slower as the project grows.
- **In CI:** to run `scan` on a server, see [`--format github` in the scan walkthrough](scan-walkthrough.md#--format-github-for-ci).
- **Not a replacement for rotating:** a value that was ever committed or shared should be rotated, as the `Next` line says.

## More

- [`scan` in the command reference](../cli.md#scan)
- [Scan walkthrough](scan-walkthrough.md)
- [Secrets: keep values out of your files](../secrets.md)
