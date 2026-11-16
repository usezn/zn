# Example: lockfiles in `zn-gate scan`

A lockfile is a long, machine-written file, and `zn-gate scan` reads some of them. This page shows what `scan` does with a lockfile, the two kinds of result you can get from one, and the options that really change it. The project and every value in it are made up. The outputs below come from runs of the npm package on throwaway folders. Every option is described in [scan](../cli.md#scan).

Run every command in your own terminal, not through your agent.

## What `scan` reads by default

`scan` reads files by extension. The default list includes `.json`, `.yaml` and `.yml`, so `package-lock.json` and `pnpm-lock.yaml` are read. A `yarn.lock` has none of the listed extensions, so it is not read unless you add `--include .lock`. Folders such as `node_modules`, `.git` and `dist` are skipped by name.

A lockfile that only holds the usual entries gives no finding. This one, with a version, a download address and a `sha512` integrity value for one package, was scanned as part of a small project:

```json
{
  "name": "example-app",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/left-pad": {
      "version": "1.3.0",
      "resolved": "https://registry.example.com/left-pad/-/left-pad-1.3.0.tgz",
      "integrity": "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA=="
    }
  }
}
```

```bash
zn-gate scan .
```

```text
Audit Result : PASSED - NO THREATS DETECTED
Files Scanned: 3
Files Skipped: 0
Status       : Clean workspace
```

The exit code is `0`. An integrity hash is not reported as a key in this run, so a hash alone is not the usual reason for noise.

## Two results you can get from a lockfile

### A finding that is real

A lockfile can hold a password if the download address does. Here the `resolved` address has a made-up user and password in it:

```json
{
  "name": "example-app",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/example-token": {
      "version": "1.0.0-beta.1234567",
      "resolved": "https://ci-user:examplepassword99@registry.example.com/example-token/-/example-token-1.0.0.tgz"
    }
  }
}
```

```text
Findings (1):
  [x] package-lock.json:7 Secret found
    Rule: secret:url_password (Exposed credential detected by DLP filter)
    Line: "resolved": "https://ci-user:[REDACTED_URL_PASSWORD]@registry.example.com/example-token/-/example-to
    Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.
```

This one is not noise. The password is in a file that is usually committed. Do not hide it: take the credentials out of the address, keep them outside the files of the project, regenerate the lockfile with your package manager, and rotate the password.

### A line that only looks like a credential

`scan` also looks for a name such as `password`, `token` or `api-key` followed by a quoted value. In a lockfile, a dependency can have such a name. A made-up lockfile whose `requires` list names packages called `password` and `api-key` was reported:

```json
{
  "name": "example-app",
  "lockfileVersion": 3,
  "packages": {
    "node_modules/example-token": {
      "version": "1.0.0",
      "requires": { "password": "2.0.0-rc.1234567", "api-key": "npm:real-api-key@1.2.3-alpha.12345" }
    }
  }
}
```

```text
Findings (1):
  [x] package-lock.json:7 Secret found
    Rule: secret:credential_assignment (Exposed credential detected by DLP filter)
    Line: "requires": { "password": "[REDACTED_SECRET]", "api-key": "[REDACTED_SECRET]" }
```

That finding is a false alarm: the values are versions. The exit code is `1`, like for a real one. It took a package name that looks like a credential name, and a version that is long enough to look random, to get it. Check each finding in a lockfile by hand: do not assume it is noise.

## The real ways to get fewer lockfile findings

`scan` has no ignore file and no option that skips one file by name. These are the options that exist.

1. **Scan the folders that hold your source, not the project root.** The path argument is any folder, and the folder you name is always read:

   ```bash
   zn-gate scan src
   ```

   In a project with a `package-lock.json` at the root and one note in `src`, this scanned one file and exited `0`, because the lockfile is not inside `src`. You lose what is outside the folder you name, so list the folders you care about and run the command once for each.

2. **Skip a folder by name with `--exclude`.** `--exclude` takes folder names, separated by commas, and skips every folder with that name below the path:

   ```bash
   zn-gate scan . --exclude web
   ```

   In a project with a lockfile at the root and another in `web`, this skipped the one in `web` and still reported the one at the root. `--exclude package-lock.json` does nothing, because it is a file name: `--exclude` is only checked against folders. Excluding a folder also skips everything else in it, so use it for folders you do not need to scan, such as a generated one.

3. **Fix the cause.** For the first kind of result above, remove the credentials from the address and rotate them. This is the only way that is right for a real finding.

## A lockfile that is too large

A file of 2 MiB or more is not read. The lockfile of a large project can be that big. It is not a finding, but a scan that skipped a file did not cover everything that matched, so the exit code is `3`. This run used a made-up lockfile of about 2.5 MiB:

```text
Audit Result : INCOMPLETE - SOME FILES WERE NOT READ
Files Scanned: 1
Files Skipped: 1 (not read: see below)
Status       : Incomplete: 1 file(s) and 0 folder(s) were not read. Exit code 3; use --allow-partial to accept

Not scanned (1):
  package-lock.json (2 MiB or larger)
```

With `--format json`, the file is in `skipped` and `incomplete` is `true`. Your choices:

- Scan the source folders only (option 1), so the file is never queued.
- Add `--allow-partial` to accept the skipped file. The exit code is then `0` and the file is still listed:

  ```bash
  zn-gate scan . --allow-partial
  ```

  This accepts every skipped file and folder, not only the lockfile, so read the list it prints.

## What was not run

These runs used the npm package (`npx zn-gate`). The Python package was not run for this page; the [reference](../cli.md#scan) says both give the same exit codes and JSON fields for skipped files and folders.

## See also

- [Scan walkthrough](scan-walkthrough.md): the report and the four exit codes of `scan`.
- [Reading a scan finding](reading-a-scan-finding.md): what each part of a finding says.
- [Scan a single file](scan-a-single-file.md): scan one file instead of a folder.
