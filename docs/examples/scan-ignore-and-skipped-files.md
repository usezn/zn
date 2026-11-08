# Scan: skipped folders, large files and `--exclude`

`zn-gate scan` does not read every file under a folder. It skips some folders by name, it does not read files of 2 MiB or larger, and you can add folders of your own with `--exclude`. This page shows what each one looks like in the report and how to scan a skipped folder on purpose. For the first run and the exit codes, see the [scan walkthrough](scan-walkthrough.md); for every option, see [scan](../cli.md#scan).

The folder below and every value in it are made up. The outputs were captured with the Node version of zn-gate in a temporary folder; the `Target` line is shortened to `~/demo`. Commands are written as `zn-gate`. There is no scan ignore file: the only ways to leave something out are the built-in names and `--exclude`.

## The example project

```text
example-project/
  README.md
  big-export.json            (2.2 MB of the letter a)
  dist/settings.txt          (a made-up key)
  docs/notes.md
  fixtures/sample.txt        (a made-up key)
  node_modules/left-pad/config.json   (a made-up key)
```

The three key files hold this line, the documentation example key that the walkthrough uses:

```text
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
```

## 1. What a default scan skips

```bash
cd example-project
zn-gate scan .
```

```text
[+]  zn-gate Static Security Audit
Target  : ~/demo/example-project
Scope   : Prompt templates, docs, configs (use --code to scan source)
Files   : 3 file(s) queued for audit

Findings (1):
  [x] fixtures/sample.txt:2 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: aws_access_key_id = [REDACTED_AWS_KEY]
    Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.


-----------------------------------------------------------------------------
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 3
Files Skipped: 1 (not read: see below)
Status       : Move the secrets out of these files (see "Next" for each one)
-----------------------------------------------------------------------------

Not scanned (1):
  big-export.json (2 MiB or larger)

Directories not scanned (1):
  dist (skipped by name: build output)
```

The `Next:` hint is printed with `npx -y zn-gate`; if you installed zn-gate, run it as `zn secret set NAME`. The exit code is `1` because of the finding.

Four things happened, and they are reported differently:

- `fixtures/sample.txt` was read. Test folders are not skipped, because fixtures can hold real secrets.
- `node_modules/left-pad/config.json` has the same key but is not mentioned anywhere. `node_modules` is skipped silently.
- `dist` is skipped by name too, but it is listed under `Directories not scanned`, because a project can keep its own prompt or agent files in a folder with that name.
- `big-export.json` matched the file types the scan reads (`.json`) but is 2 MiB or larger, so it is listed under `Not scanned` and counted in `Files Skipped`.

Which folder names are skipped (quoted from the zn-gate source, `lib/prune.js`):

| Reported (listed in the output) | Skipped without a word |
| --- | --- |
| `dist`, `build`, `.idea`, `.venv`, `venv`, `__pycache__`, `.eggs` | `node_modules`, `.git`, `.next`, `.turbo` and other dependency stores and tool caches |
| `target` (only next to a build file such as `Cargo.toml` or `pom.xml`) and `vendor` (only next to a manifest such as `go.mod` or `composer.json`) | |

A `target` or `vendor` folder with no build file next to it is an ordinary folder and is read. Inside `.vscode`, only `mcp.json` is read.

## 2. The same facts in JSON

```bash
zn-gate scan . --format json
```

```text
{
  "total_files": 3,
  "total_skipped": 1,
  "total_skipped_dirs": 1,
  "total_threats": 1,
  "total_secrets": 1,
  "incomplete": true,
  "threats": [ ... one finding, as in the text report ... ],
  "skipped": [
    {
      "file": "big-export.json",
      "reason": "2 MiB or larger"
    }
  ],
  "skipped_dirs": [
    {
      "dir": "dist",
      "reason": "skipped by name: build output"
    }
  ]
}
```

The `threats` list is shortened here. `"incomplete": true` says that part of the folder was not read. Only the reported folders appear in `skipped_dirs`; `node_modules` does not.

## 3. Scan a skipped folder on purpose

The folder you name on the command line is always read, whatever its name. Skipping only applies to folders found while walking down from it:

```bash
zn-gate scan dist
```

```text
Target  : ~/demo/example-project/dist
Files   : 1 file(s) queued for audit

Findings (1):
  [x] dist/settings.txt:2 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
...
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 1
Files Skipped: 0
```

The same works for a folder inside `node_modules`: `zn-gate scan node_modules/left-pad` read its `config.json` and found the same key. Lines marked `...` are cut for this page; the real output has the same blocks as in section 1.

## 4. Leave a folder out with `--exclude`

`--exclude` takes folder names separated by commas. They are skipped at any depth and never reported. Put the path before the options:

```bash
zn-gate scan . --exclude fixtures
```

With `fixtures` left out, the only finding is gone, but the large file and `dist` were still not read, so the scan is not clean. The exit code is `3` (output cut to the report block):

```text
Audit Result : INCOMPLETE - SOME FILES WERE NOT READ
Files Scanned: 2
Files Skipped: 1 (not read: see below)
Status       : Incomplete: 1 file(s) and 0 folder(s) were not read. Exit code 3; use --allow-partial to accept
```

To accept that, add `--allow-partial`:

```bash
zn-gate scan . --exclude fixtures --allow-partial
```

```text
Audit Result : PASSED - NO THREATS DETECTED (PARTIAL COVERAGE)
Files Scanned: 1
Files Skipped: 1 (not read: see below)
Status       : Partial coverage accepted with --allow-partial (1 file(s) and 0 folder(s) were not read)
-----------------------------------------------------------------------------

Not scanned (1):
  big-export.json (2 MiB or larger)

Directories not scanned (1):
  dist (skipped by name: build output)
```

(This capture is from a smaller project with `README.md`, `dist/notes.md`, `fixtures/sample.txt` and the large file.) Exit `0`, and the skipped file and folder are still listed. Naming `dist` in `--exclude` as well (`--exclude fixtures,dist`) removes the `Directories not scanned` block, but the large file is still listed, because `--exclude` takes folders, not files.

## What to check

- A scan that says `Files Skipped` or `Directories not scanned` did not look at those places. A clean result means clean for what was read.
- Do not use `--allow-partial` to make a CI job green without reading the list first. The list says what no one checked.
- A skipped folder that matters (a `dist` that you commit, a large JSON that holds config) can be scanned on its own by naming it, as in section 3.
- `--exclude` hides a folder from the report. Use it for folders you have decided never matter, such as test data you keep on purpose.
- `--package` is the other way around: it reads a downloaded package in full and skips no folder by name, `node_modules` included.

## See also

- [Scan walkthrough](scan-walkthrough.md): the first run, the exit codes and `--format github`.
- [Reading a scan finding](reading-a-scan-finding.md): what one finding block tells you.
- [scan reference](../cli.md#scan): all options.
