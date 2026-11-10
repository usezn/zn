# Example: scan one package of a monorepo

A monorepo keeps several packages in one repository, each in its own folder. `zn-gate scan` takes any folder as its path, so you can scan one package on its own, or every package in turn. This page uses a made-up layout. Run the commands in your own terminal, from the root of the repository.

```text
shop/                      (the repository)
  packages/
    api/                   (the package this page scans)
      prompts/review.md
      fixtures/            (test data, made up)
    web/
```

Every option is described in [scan](../cli.md#scan).

## 1. Scan the package folder

```bash
zn-gate scan packages/api
```

Only the files under `packages/api` are read. The report says how many files were scanned, so you can check that the count is what you expect. A path that does not exist exits with `1`.

By default `scan` reads prompt templates, markdown, skills and configuration files. It does not read source code such as `.js` or `.ts` files. For source code too, add `--all`:

```bash
zn-gate scan packages/api --all
```

## 2. Skip a folder by its name

`--exclude` takes folder names, not paths:

```bash
zn-gate scan packages/api --exclude fixtures
```

Every folder named `fixtures` inside the scanned tree is skipped, and it is never reported. Folders skipped by name such as `node_modules` are skipped in the same way. To skip a folder with a name that appears elsewhere too, scan a narrower folder instead of excluding it.

Use `--exclude` for test data you know is fake. Do not use it to hide a folder you have not looked at.

## 3. Scan every package, one after another

Put the loop in a script of your own, or type it in your terminal. It scans each package and keeps the worst exit code, so a finding in any package still fails the run:

```bash
#!/usr/bin/env bash
status=0
for pkg in packages/*/; do
  echo "== $pkg"
  zn-gate scan "$pkg" || status=$?
done
exit $status
```

The codes are the same as for one folder ([scan exit codes](../cli.md#scan)):

| Code | Meaning for a package |
| --- | --- |
| `0` | Nothing found, and everything that matched was read |
| `1` | Something was found, or the path does not exist |
| `3` | Part of the package was not read: no file was read, or a file or folder could not be read |

Exit code `3` means the result does not cover the package. Fix the access, or accept the gap on purpose with `--allow-partial`, which still lists the skipped files.

## Not the same as --package

`scan --package <name>` checks an npm package from the registry. It does not read folders of your repository, and it refuses `--exclude` and a folder argument. For the packages in this repository, use the path form shown above.

## Related

- [Example: scan a single file](scan-a-single-file.md): the same command with one file as the path.
- [Example: scan walkthrough](scan-walkthrough.md): one small project, from the run to the exit codes.
- [Example: scan in CI](ci-secret-scan-gate.md): a job that fails when a scan finds a secret.
