# Example: the local evidence log in practice

Three everyday tasks with the local evidence log of zn-gate: list the last records, check the chain, and save the records to a file. For every option, see the [command line reference](../cli.md#evidence). For a sample of what the commands print, see [Example: the decision log](evidence-example.md).

The log is the local hash-chained log of what zn-gate decided. It is kept in the zn folder, `~/.zn` by default or the folder that `ZN_HOME` names (see [all environment variables](../cli.md#all-environment-variables)).

## Goal

See what zn-gate decided recently, check that the log was not changed, and keep a copy in a file of your own.

## List the last records

```bash
zn-gate evidence
```

With no option, the command prints the counts and the last 20 records. To see a different number, use `--tail`:

```bash
zn-gate evidence --tail 5
```

`zn-gate logs` is another name for the same command, so `zn-gate logs --tail 5` does the same.

## Check the chain

```bash
zn-gate evidence --verify
```

This checks the SHA-256 chain of the log. The command ends with exit code `0` when the chain is intact, and with exit code `1` if the log was changed. In a script, test the exit code:

```bash
zn-gate evidence --verify || echo "The evidence log was changed."
```

Run the check before you export, so that you know the copy you save comes from an intact log.

## Export to a file

Make a folder for the copy, then write the records to a file in it. The fake folder `~/zn-export` is only an example:

```bash
mkdir -p ~/zn-export
zn-gate evidence --export --output ~/zn-export/evidence.jsonl
```

With `--format` left out, the records are written as `jsonl`. For `csv`, name the format:

```bash
zn-gate evidence --export --format csv --output ~/zn-export/evidence.csv
```

Leave out `--output` to print the records on the screen instead.

The command line reference also lists `export` as a short name for `evidence --export`. This page uses the full form.

## In the Python package

The `evidence` command of the Python package has `--verify`, `--export`, `--format jsonl|csv` and `--output file`. It has no `--tail` and no `logs` or `export` alias, so use `zn-gate evidence --export` there. See [the Python package](../cli.md#the-python-package) in the command line reference.

## See also

- [Command line reference](../cli.md#evidence): all options of `evidence`.
- [Example: the decision log](evidence-example.md): sample output of the counts, `--tail` and `--verify`.
- [Example: open the decision log in a spreadsheet](zn-evidence-export-to-csv-for-a-spreadsheet.md): the CSV export, column by column.
- [Check that it works](../check.md): what `zn-gate check` prints. Its decision time does not include saving evidence.
