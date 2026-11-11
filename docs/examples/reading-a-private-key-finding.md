# Example: reading a private key finding

[Reading a scan finding in JSON](reading-a-scan-finding.md) explains the fields
of a finding for an access key. This page explains a finding for a private key:
a block that starts with a `BEGIN ... PRIVATE KEY` line and ends with an `END`
line. The key in the example is fake. Its body is repeated letters, and the
header shows only the placeholder `...` where the algorithm name goes.

## The project

A folder called `fixture` with one file, `notes.md`. The key block starts on
line 4:

```text
# Notes

Deploy key for the demo (fake):
-----BEGIN ... PRIVATE KEY-----
...
-----END ... PRIVATE KEY-----

Ask the platform team for the real one.
```

The `...` on the header line stands for the algorithm name (such as `RSA` or
`OPENSSH`), and the `...` line stands for the four lines of key body. Neither
is written out in this page.

## The scan

Run this from the folder that contains `fixture`:

```sh
zn-gate scan fixture
```

Output, shortened: the scope line and the target path are left out.

```text
[+]  zn-gate Static Security Audit
Files   : 1 file(s) queued for audit

Findings (1):
  [x] fixture/notes.md:4 Secret found
    Rule: secret:private_key (Exposed credential detected by DLP filter)
    Line: -----BEGIN ... PRIVATE KEY-----
    Next: move the key out of this file (for example to ~/.ssh or a secret manager) and replace it if the file was ever committed or shared.

-----------------------------------------------------------------------------
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 1
Files Skipped: 0
Status       : Move the secrets out of these files (see "Next" for each one)
-----------------------------------------------------------------------------
```

The command exits with `1`, because it found a secret. A clean scan exits with `0`.

## Each part of the finding

| Part | Meaning |
|---|---|
| `Findings (1)` | How many findings there are. |
| `fixture/notes.md:4` | The file, and the line where the finding starts. Line 4 is the `BEGIN` line, the first line of the block. |
| `Secret found` | The kind of finding. In JSON, the type is `secret_leak`. |
| `Rule: secret:private_key` | The rule that matched. The part before the colon is the kind of rule (`secret`); the rest names the credential (`private_key`). |
| `(Exposed credential detected by DLP filter)` | The reason, the same text as the `reason` field in JSON. |
| `Line:` | The line where the block starts. The body lines are not printed, so the key material does not appear in the report. |
| `Next:` | What to do. It is present only when zn has a suggestion. |
| `Audit Result` | `FAILED` when at least one secret was found. |
| `Files Scanned` and `Files Skipped` | The files that were read and the files that were not. A skipped file gives exit `3` instead of `1` (see [the CLI reference](../cli.md#scan)). |

The same finding in the other formats:

- `--format json` gives one entry in `threats`, with `"rule": "secret:private_key"`,
  `"line": 4` and `"content": "-----BEGIN ... PRIVATE KEY-----"`. The body is not
  in the entry either.
- `--format github` prints one annotation on line 4 of `fixture/notes.md`, with
  the same `next_step` text as the `Next:` line.

## What to do

1. Treat the key as leaked if it was ever committed, pushed or shared, and stop
   using it.
2. Rotate it. Create a new key pair, put the new public key where the old one was
   accepted, and remove the old public key from the servers or accounts that
   trust it. Rotation is the step that makes a leaked copy useless. Removing the
   line from the file does not do this.
3. Remove the key from the file. Keep the new private key in `~/.ssh`, readable
   only by you, or in a secret manager, and point your tools there. [The secrets
   guide](../secrets.md) shows the vault.
4. If the key was committed, remove it from the git history too. A new commit
   that deletes the line leaves the key in the old commits, and `scan` does not
   look at history. A tool such as `git filter-repo` rewrites the history. Force
   pushing a rewritten history needs your team's agreement, and clones, forks and
   CI caches may still hold the old commits, which is one more reason to rotate.
5. Scan again. `zn-gate scan fixture` should now exit with `0`.

## A test fixture that really is fake

If the block is a fake key that your tests need, you can skip its folder with
`--exclude`. The option takes folder names, not file names:

```sh
zn-gate scan . --exclude fixture
```

Output, shortened:

```text
Audit Result : PASSED - NO THREATS DETECTED
Files Scanned: 1
Files Skipped: 0
Status       : Clean workspace
```

The command exits with `0`. Use this only for folders that never hold a real key,
because every file in an excluded folder is skipped.

## Next steps

- [The scan walkthrough](scan-walkthrough.md) explains the text report for a
  small project.
- [Reading a scan finding in JSON](reading-a-scan-finding.md) explains the
  fields of a key finding for scripts.
- [The secrets guide](../secrets.md) shows how to keep a value in the vault.
- [The CLI reference](../cli.md#scan) lists every option of `scan`.
