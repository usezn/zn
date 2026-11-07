# Example: the cloud check settings

The settings that control the optional cloud check, each with its effect, one command with fake values, and what leaves your machine. The effects are copied from the Settings table of the [command line reference](../cli.md#settings). For the full behaviour, read [Turn on the optional cloud check](../connect.md).

By default nothing leaves your machine. Only `analyze` and `analyze_prompt` can use the cloud check, and only when it is on. Every other command stays local.

| Setting | Effect | Example command (fake values) | What leaves the machine |
|---|---|---|---|
| `ZN_CLOUD=1` | Turns the optional cloud check on. Without it (or `zn-gate connect`) nothing leaves your machine. | `ZN_CLOUD=1 ZN_API_KEY=example-fake-key zn-gate analyze "some text"` | The text, with the secrets zn-gate detects hidden first, and the key as a request header. |
| `ZN_LOCAL_ONLY=true` or `--local-only` | Never use the cloud, even when `ZN_CLOUD=1` is set. | `ZN_CLOUD=1 ZN_API_KEY=example-fake-key ZN_LOCAL_ONLY=true zn-gate analyze "some text"` | Nothing. |
| `ZN_STAGE` or `--stage <v30\|prod>` | Cloud stage. Default `v30`. | `ZN_CLOUD=1 ZN_API_KEY=example-fake-key ZN_STAGE=prod zn-gate analyze "some text"` | The same as with `ZN_CLOUD=1`: the text and the key. The stage chooses which cloud stage receives them. |
| `ZN_API_URL` or `--url <url>` | Use another cloud address. | `ZN_CLOUD=1 ZN_API_KEY=example-fake-key ZN_API_URL=https://cloud.example.com zn-gate analyze "some text"` | The text and the key go to that address instead. A key saved by `zn-gate connect` is only ever sent to <https://api.usezn.com>, and `--url` and `ZN_API_URL` are ignored for it. |
| `--long-input <windows\|off>` | How long texts are sent to the cloud check: in overlapping windows (default, up to 20), or only the first 512 tokens. Any other value exits `2`. | `ZN_CLOUD=1 ZN_API_KEY=example-fake-key zn-gate analyze --long-input off "some long text"` | With `off`, only the first 512 tokens of the text. With `windows`, the whole text in up to 20 overlapping windows. |

Without `ZN_CLOUD=1` (and without `zn-gate connect`), none of these settings sends anything: `ZN_STAGE`, `ZN_API_URL` and `--long-input` only matter once the cloud check is on.

## What is sent when the cloud check is on

Only the text of `analyze_prompt` and `zn-gate analyze` calls, after zn-gate removed the secrets it detects, and the key as a request header. Personal data is not removed on this path, and a secret zn-gate does not recognize is sent with the text. Tool-call arguments and tool descriptions are never sent. Tool output is sent only by the Claude Code hook, as a sample of at most 16 KiB of each web, MCP or shell result, with secrets, email addresses, phone numbers, IBANs and card numbers removed first, and `"cloudCheckToolOutput": false` under `hooks` in `~/.zn/config.json` turns that off. If the cloud call fails, the text is checked by the local rules alone.

`zn-gate status` shows the state at any time.

## Further reading

- [Command line reference](../cli.md#settings)
- [Turn on the optional cloud check](../connect.md)
- [Example: running offline and with the cloud check off](offline-and-local-only.md)
