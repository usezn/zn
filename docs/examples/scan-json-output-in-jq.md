# Example: filter scan results with jq

`zn-gate scan --format json` prints one JSON object with a list of findings.
This page shows how to count the findings, list where they are, and filter them
by rule or type with [jq](https://jqlang.org/), a command-line JSON tool. For what
each field means, read [reading a scan finding](reading-a-scan-finding.md) first.
All values here are made up. The key is the example key from AWS's own
documentation.

## The project

A folder called `demo` with two files that both contain the example key:

```text
demo/.env               line 1: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
demo/docs/notes.md      line 2: Deploy key for the demo: AKIAIOSFODNN7EXAMPLE
```

## Save the report to a file

Run this from the folder that contains `demo`:

```sh
zn-gate scan demo --format json > scan.json
```

`scan` exits with `1` when it finds something, so the examples read the saved
file instead of piping the scan straight into jq. The filters use single quotes,
as in bash, zsh or Git Bash.

## Count the findings

```sh
jq '.total_threats' scan.json
```

Output:

```text
2
```

`total_threats` counts every finding. `total_secrets` counts only the leaked
secrets. The same count is `jq '.threats | length' scan.json`.

## List the file and line of each finding

```sh
jq -r '.threats[] | "\(.file):\(.line)"' scan.json
```

Output:

```text
demo/.env:1
demo/docs/notes.md:2
```

`-r` prints the text without JSON quotes.

## See which rules were found

```sh
jq -r '[.threats[].rule] | unique | .[]' scan.json
```

Output:

```text
secret:aws_access_key
```

## Filter by rule

```sh
jq -r '.threats[] | select(.rule == "secret:aws_access_key") | "\(.file):\(.line)"' scan.json
```

Output:

```text
demo/.env:1
demo/docs/notes.md:2
```

Use the rule text exactly as the previous example printed it, including the
part before the colon.

## Filter by type

Scan findings have no severity field. The closest field is `type`: `secret_leak`
marks a leaked secret, and other findings have another type. To see the types
in the report:

```sh
jq -r '[.threats[].type] | unique | .[]' scan.json
```

Output:

```text
secret_leak
```

To list only the leaked secrets, with their rule:

```sh
jq -r '.threats[] | select(.type == "secret_leak") | "\(.file):\(.line)  \(.rule)"' scan.json
```

Output:

```text
demo/.env:1  secret:aws_access_key
demo/docs/notes.md:2  secret:aws_access_key
```

## Show the redacted line

The `content` field has the matched value replaced by a placeholder, so it is
safe to print or paste:

```sh
jq -r '.threats[] | "\(.file):\(.line)  \(.content)"' scan.json
```

Output:

```text
demo/.env:1  AWS_ACCESS_KEY_ID=[REDACTED_AWS_KEY]
demo/docs/notes.md:2  Deploy key for the demo: [REDACTED_AWS_KEY]
```

## Check that every file was read

`incomplete` is `true` when a file or folder was not read. In that case the
scan exits with `3`.

```sh
jq '.incomplete' scan.json
```

Output:

```text
false
```

## Use jq in a script

With `-e`, jq sets its exit code from the result: `1` when the result is `false`
or `null`, `0` otherwise. This example fails when the report has any finding:

```sh
jq -e '.total_threats == 0' scan.json
echo "exit code $?"
```

Output:

```text
exit code 1
```

Here the exit code `1` means the check failed, because the report has findings.

## Next steps

- [Reading a scan finding](reading-a-scan-finding.md) explains each field.
- [The CLI reference](../cli.md#scan) lists every option of `scan`.
- [CI secret scan gate](ci-secret-scan-gate.md) shows a CI job that fails on a secret.
