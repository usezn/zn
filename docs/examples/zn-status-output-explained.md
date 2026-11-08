# Example: reading the output of zn status, line by line

`zn status` prints a short block that says which zn-gate you are running and whether anything can leave your computer. It is not a health check: it does not test your agents or read their hooks (for that, see [Check that it works](../check.md)). This page takes the block one line at a time, then shows the lines that appear only in some setups. The outputs are from real runs in a throwaway home folder, with a made-up key, and the home folder is shown as `~`. Your version numbers will differ. Commands are written as `zn`; if you have not installed zn-gate, use `npx -y zn-gate status`.

The command only reads. It changes nothing, never prints a key, and always exits `0`, even when it prints a note.

## 1. The default block

```bash
zn status
```

```text
[+]  zn-gate Status:
  Package Version : 1.15.0
  Rules Version   : 2026-11-07.1 (scrub 2026-10-31.1, audit 2026-11-06.3)
  Active Engine   : Local rules only
  Endpoint        : None (nothing leaves this machine)
  API key         : Not set
  Leaves machine  : Nothing
```

| Line | What it tells you |
|---|---|
| `[+]  zn-gate Status:` | The title. In a terminal it starts with a shield; in a pipe, a file or with `NO_COLOR` set it is the ASCII marker `[+]`. |
| `Package Version` | The version of zn-gate that ran. It is the same number `zn version` prints first. |
| `Rules Version` | The version of the rules that decide what to block. The numbers in brackets are the versions of the scrub rules and of the audit rules. When you report a problem, these are the numbers to include. |
| `Active Engine` | What decides. `Local rules only` means every decision is made on your computer. |
| `Endpoint` | Where text could be sent. `None (nothing leaves this machine)` says it cannot. |
| `API key` | Whether a key for the optional [cloud check](../connect.md) is known to zn, and where it comes from. |
| `Leaves machine` | A summary of the lines above: `Nothing`. |

## 2. A key is set, but the cloud check is off

A key alone does not turn the cloud check on. With a made-up key in `ZN_API_KEY` and nothing else:

```text
  Active Engine   : Local rules only
  Endpoint        : None (nothing leaves this machine)
  API key         : Set (ZN_API_KEY) (unused: cloud requires ZN_CLOUD=1)
  Leaves machine  : Nothing
```

The key is `Set`, the text in brackets says where it comes from (`ZN_API_KEY`, `--key`, or, after `zn connect`, your system keychain or the zn vault), and `(unused: cloud requires ZN_CLOUD=1)` says why `Leaves machine` is still `Nothing`. The key is never printed.

## 3. The cloud check is on

The same key with `ZN_CLOUD=1`:

```text
  Active Engine   : Local rules + cloud for analyze_prompt (ZN_CLOUD=1)
  Endpoint        : https://api.usezn.com/v30/analyze
  API key         : Set (ZN_API_KEY)
  Leaves machine  : analyze_prompt text only, secrets redacted locally first
```

Now `Active Engine` names the cloud, `Endpoint` shows the address, and `Leaves machine` says exactly what can leave: the text of `analyze_prompt` only, with secrets hidden on your computer first. Everything else still stays local. `ZN_CLOUD=1` with no key at all changes nothing: the block is the one in section 1. See [Turn on the optional cloud check](../connect.md).

If you ran `zn connect`, one more line follows `API key`: `Connected       : yes, key ...` and the last four characters of the key, and the command that turns it off. If the saved key cannot be found any more, for example because the vault is locked, the line says so and that the check falls back to local rules.

## 4. Notes after the block

Some setups add a line below the block. They are warnings and never change the exit code. Two examples from the same code:

- **A setting that turns the hooks off.** With Claude Code present and `"disableAllHooks": true` in its settings file, the run added:

  ```text
    Claude Code     : ~/.claude/settings.json sets disableAllHooks, so no hooks you install run, zn's included. Remove that setting to turn them on.
  ```

  `zn status` only notes it; `zn check` is the command that reports the agent as not protected.
- **Zn installed by your organization.** For Claude Code, Codex CLI and Cursor, a line `<agent>: zn is installed (managed): <file>` names the managed configuration file. See [Check that it works](../check.md).

The same place also carries a note when your Node.js is end of life or unpatched (a line starting `Node.js`). Nothing here was run, changed or sent.

## 5. Extra words are ignored

`zn status extra` printed the same block and exited `0`. There are no options.

## What to check

- `Leaves machine` should say `Nothing` unless you turned the cloud check on yourself.
- Put `Package Version` and `Rules Version` into a bug report, next to the output of `zn version`.
- For whether your agents are protected, run [`zn check`](check-output-explained.md), not `zn status`.

## See also

- [`status` in the command reference](../cli.md#status)
- [Exit codes](../exit-codes.md): `status` always exits `0`.
