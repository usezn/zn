# Example: keep generated folders out of a scan

A scan of a project should look at the files you wrote, not at the packages and build output around them. Most generated folders are already skipped. This page lists which ones, how the skip is reported, and how to skip a folder of your own or scan only part of a project. All values are made up. For every option, see the [command line reference](../cli.md#scan).

## Goal

Run `zn-gate scan` on a project and know what it skipped and why, without reading the generated files.

## What is skipped by default

`zn-gate scan` does not enter these folders, wherever they are in the tree:

| Folder name | What the report shows |
|---|---|
| `node_modules`, `.git`, `.next`, `.turbo` | Skipped without a line in the report. |
| `.idea`, `.venv`, `venv`, `__pycache__`, `.eggs` | Skipped and listed as `skipped by name: ...` (editor settings, virtual environment, Python cache, Python build files). |
| `dist`, `build` | Skipped and listed as `skipped by name: build output`. |
| `target` | Skipped and listed only when a build file sits next to it (`Cargo.toml`, `pom.xml`, `build.gradle`, `build.gradle.kts` or `build.sbt`). Otherwise it is read. |
| `vendor` | Skipped and listed only when a package file sits next to it (`go.mod`, `composer.json`, `Gemfile` or `Cargo.toml`). Otherwise it is read. |

Test folders such as `fixtures` are not on the list. They are read, because a sample configuration in them can hold a real secret.

A folder that is listed is not counted as a file that could not be read, so it does not change the exit code. The text report shows it in its own section:

```text
Directories not scanned (1):
  dist (skipped by name: build output)
```

With `--format json`, the same entries are in `skipped_dirs`.

## Skip a folder of your own

Pass its name to `--exclude`. The option takes folder names separated by commas, not paths:

```bash
zn-gate scan . --exclude fixtures,legacy
```

A name given to `--exclude` is skipped in every part of the tree and is not listed in the report. A path does not work: `--exclude fixtures/sample.md` changes nothing, and the file is still read. To skip one file, move it out of the scanned folder or scan the folders you need one at a time.

## Scan only a part of the project

Pass the folder you want as the path. The folder you pass is always read, even when its name is on the list above:

```bash
zn-gate scan ./docs
```

This is the simplest way to keep a large generated tree out of one check: scan the source folder by itself.

## The size limit

A file of 2 MiB or larger is not read. It is listed as not read, and the scan exits with `3` unless you pass `--allow-partial`. Generated bundles are often that large, so a scan can report a file you did not expect. If it is a generated file you do not need, skip its folder with `--exclude`, or leave it out of the path you scan. The rules are in [the scan reference](../cli.md#scan).

## See also

- [Command line reference: scan](../cli.md#scan): all options and exit codes.
- [Read the scan report](reading-a-scan-finding.md): what each field of the report means.
- [Scan walkthrough](scan-walkthrough.md): one run from start to finish, with the four exit codes.
