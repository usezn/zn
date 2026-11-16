# Example: reading a scan finding that is not a real secret

A scan finding is not always a leaked secret. A test file can hold a sample key
from a vendor's documentation, and a fixture can copy the shape of a real
config. This page shows how to judge such a finding and the ways `zn-gate scan`
really offers to skip it. [Reading a scan finding](reading-a-scan-finding.md)
explains the fields of a finding. Every value here is made up.

## The project

A folder called `demo` with two files:

```text
demo/docs/setup.md
demo/fixtures/sample-config.json
```

`setup.md` holds lines that look like secrets but are not:

```text
api_key = "your-key-here"
export DB_PASSWORD=changeme
Checksum of the release: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
Build id: 3f2a9c1e-7b4d-4e8a-9c3b-1d2e3f4a5b6c
```

`sample-config.json` is a test fixture. Line 3 holds the example key from AWS's
own documentation:

```json
{
  "name": "fixture",
  "aws_access_key_id": "AKIAIOSFODNN7EXAMPLE",
  "note": "this is a sample used by the unit tests"
}
```

## The finding

```sh
zn-gate scan demo
```

Output (the `Target` line shows the full path on your computer):

```text
Findings (1):
  [x] demo/fixtures/sample-config.json:3 Secret found
    Rule: secret:aws_access_key (Exposed credential detected by DLP filter)
    Line: "aws_access_key_id": "[REDACTED_AWS_KEY]",
    Next: run npx -y zn-gate secret set NAME to store the value in the local vault, use the __ZN_NAME__ marker in its place, and rotate it if it was ever committed or shared.

-----------------------------------------------------------------------------
Audit Result : FAILED - 1 SECRET(S) FOUND
Files Scanned: 2
Files Skipped: 0
Status       : Move the secrets out of these files (see "Next" for each one)
-----------------------------------------------------------------------------
```

The command exits with `1`. Notice what the scan did not report: the
placeholders, the checksum and the build id in `setup.md` are left alone. A
value such as `your-key-here` or `changeme` is read as a placeholder, and a
hash or an id is not shaped like a credential.

## How to judge it

The report never prints the value, so look at the line in the file itself.

1. Open the file at the line in the report (`sample-config.json`, line 3).
2. Ask where the value comes from. A key copied from a vendor's documentation
   page is public. A key that came from your own account is not.
3. Ask whether it ever worked. If you are not sure, treat it as real: use the
   `Next:` advice and rotate it if it was ever committed or shared.
4. Ask whether the file is meant to hold it. A fixture in a test folder is
   expected to hold fake values. A `.env` file in the project root is not.

Only skip a finding when you can answer steps 2 and 3 with certainty.

## The ways to skip it

The CLI reference documents one option for this, and the code reads it
([`scan` in the CLI reference](../cli.md#scan)):

```sh
zn-gate scan demo --exclude fixtures
```

Output (shortened):

```text
Files   : 1 file(s) queued for audit

Audit Result : PASSED - NO THREATS DETECTED
Files Scanned: 1
Files Skipped: 0
```

The command exits with `0`. What `--exclude` does and does not do:

- It takes folder names, separated by commas: `--exclude fixtures,legacy`.
- A name matches a folder with exactly that name, at any depth, and the match
  is case sensitive. A folder that is skipped this way is not listed as
  skipped.
- It does not take file names or paths. `--exclude sample-config.json`,
  `--exclude fixtures/sample-config.json` and `--exclude fixtures/` all left
  the finding in place when we ran them.
- It skips everything in that folder, real secrets included. Use it only for a
  folder that holds nothing but fake values.
- It never skips the folder you pass to `scan`.
- If the names leave no file to read, the scan reports that nothing was
  scanned and exits with `3`, not `0`.

There is no ignore comment and no ignore file. A trailing comment on the line,
such as `# zn-ignore`, changes nothing: the same finding is reported. Two other
choices remain:

- Change the value in the file to an obvious placeholder, such as
  `your-key-here`, which the scan leaves alone.
- Scan the files that matter, and not the fixtures, by passing a narrower path
  (`zn-gate scan demo/docs`). [Scanning a single file](scan-a-single-file.md)
  shows how.

## Next steps

- If the value is real, move it into the vault with `zn-gate secret set NAME`.
  [The secrets guide](../secrets.md) shows how.
- To run the scan in CI with the same `--exclude` option, see
  [the CI secret scan gate](ci-secret-scan-gate.md).
- For every option of `scan`, see [the CLI reference](../cli.md#scan).
