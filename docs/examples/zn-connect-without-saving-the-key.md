# Turn on the cloud check with an environment variable

`zn-gate connect` saves your key in the system keychain or in the zn vault. If you do not want zn-gate to save a key, you can turn the optional cloud check on for one shell session with two environment variables instead. zn-gate saves nothing, and you do not run `connect`.

The cloud check only adds a second opinion for prompt analysis (`analyze_prompt` and `zn-gate analyze`). Local rules still run first, and the hooks keep working locally. See [Turn on the optional cloud check](../connect.md) for what leaves your computer.

All values on this page are fake. Use your own key from the [connect page](https://usezn.com/connect), and an analysis-only key, the kind `zn-gate connect` accepts.

## 1. Set the two variables

In your own terminal, bash or zsh:

```bash
export ZN_CLOUD=1
export ZN_API_KEY="zn_live_EXAMPLE_not_a_real_key_0000"
```

In Windows PowerShell:

```powershell
$env:ZN_CLOUD = "1"
$env:ZN_API_KEY = "zn_live_EXAMPLE_not_a_real_key_0000"
```

Both are needed:

- `ZN_CLOUD` must be exactly `1`. Any other value keeps the cloud check off. (`packages/zn-gate/lib/client.js:78`)
- `ZN_API_KEY` alone enables nothing. The key must be 16 to 256 characters, letters, digits, `.`, `_` or `-` only. A placeholder that was never filled in, such as `${user_config.api_key}`, counts as no key. (`packages/zn-gate/lib/client.js:61`, `packages/zn-gate/lib/cloud-key.js:28` and `:100-104`)

zn-gate does not apply to this key the connection checks it applies to a saved key (for example, it does not refuse `NODE_EXTRA_CA_CERTS`). Those checks are for keys that `connect` stored. (`packages/zn-gate/lib/cloud-key.js:36-38`)

## 2. Check what zn-gate sees

```bash
npx -y zn-gate status
```

With the two variables set, these lines say that the cloud check is on and where the key comes from. The key itself is never printed. (`packages/zn-gate/bin/cli.js:1505-1510`)

- `Active Engine` says `Local rules + cloud for analyze_prompt (ZN_CLOUD=1)`.
- `API key` says `Set (ZN_API_KEY)`.

If `API key` says `Set (ZN_API_KEY) (unused: cloud requires ZN_CLOUD=1)`, the key is set but `ZN_CLOUD` is not `1`. Set `ZN_CLOUD=1` in the same terminal and run `status` again. (`packages/zn-gate/bin/cli.js:1508`)

## 3. Try one prompt

```bash
npx -y zn-gate analyze -- "Please summarize this page."
```

The command prints one JSON object and exits:

- `0` when the text is allowed.
- `2` when the text is blocked. (`packages/zn-gate/bin/cli.js:1492`; [analyze in the command reference](../cli.md#analyze))

Look at two fields:

- `mode` is `hybrid-cloud` when the cloud answered. (`packages/zn-gate/lib/client.js:268`)
- `fallback: true` with a `cloud_error` text means the cloud check did not run and the local rules gave the answer. The text names the reason. (`packages/zn-gate/lib/client.js:244`, `:255`, `:259`)

If `cloud_error` says `no API key available (run zn-gate status)`, check that both variables are set in the terminal you ran the command in. (`packages/zn-gate/lib/client.js:244`)

## 4. Turn it off

Remove the variables from the terminal:

```bash
unset ZN_CLOUD ZN_API_KEY
```

```powershell
Remove-Item Env:ZN_CLOUD
Remove-Item Env:ZN_API_KEY
```

To keep the variables set but force local rules only, set `ZN_LOCAL_ONLY=true`. It overrides the other settings and the cloud check stays off. (`packages/zn-gate/lib/client.js:68`; [Command line reference](../cli.md#settings))

## Saved key and environment key together

- With `ZN_CLOUD=1` and `ZN_API_KEY` set, the environment key is used, even if you connected before. The saved key is not used in that case. (`packages/zn-gate/lib/cloud-key.js:312-316`, `packages/zn-gate/lib/client.js:237-240`)
- Without `ZN_CLOUD=1`, a saved connection is used and `ZN_API_KEY` is ignored. (`packages/zn-gate/lib/client.js:235-237`)
- Without a saved key and without `ZN_CLOUD=1`, prompts are checked by the local rules only. (`packages/zn-gate/lib/client.js:67-72`)

## What this does not change

- Tool output is not sent to the cloud because of these two variables. That path needs `zn-gate connect` and a setting in your own `~/.zn/config.json`. (`packages/zn-gate/lib/hooks/runner.js:119`)
- The key is in your shell's environment, so any program you start from that shell can read it. Use an analysis-only key, do not write it into a project file or a script you commit, and clear the variables when you are done.
- The Python package reads the same two variables and never a saved key. (`packages/zn-gate-py/src/zn_gate/client.py:41-43`; [Python API](../api-reference.md))

## Related

- [Turn on the optional cloud check](../connect.md): the saved-key route, with `connect` and `disconnect`.
- [Command line reference](../cli.md): the `status` and `analyze` commands and the variables table.
