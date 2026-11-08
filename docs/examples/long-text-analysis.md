# Example: checking a long text

How the optional cloud check reads a long text: the two modes of the long-input setting, when the result carries a warning, and one command for each mode. For what the cloud check sends, read [the cloud check settings](cloud-check-settings.md).

The long-input setting matters only once the cloud check is on. It chooses how a long text is sent to the cloud classifier. The default is `windows`: the classifier reads the text in overlapping windows instead of only the beginning of the text. With `off`, only the beginning of the text is sent.

## The two modes

The setting is read from the `ZN_LONG_INPUT` variable or from the option:

- `zn-gate analyze` takes `--long-input <windows|off>`. Any other value exits `2`.
- The Node `analyze` takes the `longInput` option (`windows` or `off`); the Python `analyze` takes `long_input`.

For `ZN_LONG_INPUT` and the library options, `off`, `none`, `truncate`, `0`, `false` and `no` (any case) mean `off`; any other value means `windows`.

## One command for each mode

With the cloud check on, fake values:

- `windows` (the default): `ZN_CLOUD=1 ZN_API_KEY=example-fake-key zn-gate analyze --long-input windows "some long text"`
- `off`, set with the variable instead of the option: `ZN_CLOUD=1 ZN_API_KEY=example-fake-key ZN_LONG_INPUT=off zn-gate analyze "some long text"`

## When the result carries a warning

When the cloud check ran on a long text, the result can carry a `warning` field saying that part of the text was not analyzed. It appears in two cases:

- The cloud gate says the text is longer than what it checks: the warning says that the end was not analyzed.
- In `windows` mode, the cloud gate answers that it read only the beginning of the text: the warning says that only the beginning was checked.

## Further reading

- [Example: the cloud check settings](cloud-check-settings.md)
- [API reference: `longInputMode`](../api-reference.md#longinputmodeoptions)
- [Command line reference](../cli.md#settings)
