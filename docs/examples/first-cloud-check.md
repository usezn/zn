# Example: your first cloud check

The shortest path from [Turn on the optional cloud check](../connect.md) to a first checked prompt, in five steps. All the text in the commands is fake. Run every command yourself, in your own terminal: `connect` and `disconnect` refuse to run when an AI agent starts them or there is no terminal. The full behaviour is on the [connect page](../connect.md) and in the [command reference](../cli.md); the longer walk-through is [connect, check the status and disconnect](connect-and-disconnect.md).

## 1. Connect

```bash
npx -y zn-gate connect
```

(or `zn-gate connect` if you installed it with `npm i -g zn-gate`).

The command tells you what will change and asks you to confirm, then opens <https://usezn.com/connect/> in your browser. Create an account (or log in) and create an analysis-only API key there. Back in the terminal, paste the key the connect page gives you at the hidden prompt. Nothing you type is shown. When the key is saved, the command prints its last four characters so you can recognise it.

## 2. Check that you are connected

```bash
npx -y zn-gate status
```

`status` shows the version, the rules version, whether the optional cloud check is on and where the key comes from. It never shows the key and always exits `0`. From now on, the text of every `zn-gate analyze` call, with detected secrets hidden first, is also checked at usezn.com.

## 3. Check a prompt

```bash
npx -y zn-gate analyze "Summarize the changelog for the release notes."
```

The answer is JSON. For an ordinary text like this the verdict is `allow`; a prompt-injection attempt is blocked. The `mode` field shows which check answered.

## 4. Read the mode

- `"mode": "hybrid-cloud"`: the online check answered. When you are connected and the cloud call succeeds, an ordinary text comes back with this mode.
- `"mode": "oss-local"` with `"fallback": true`: the cloud call failed, and the local rules on your machine checked the prompt alone. The `cloud_error` field says what went wrong, and the check does not fail closed.
- `"mode": "oss-local"` without `"fallback"`: the cloud check was off for that run.

## 5. Turn it off again

Keep the cloud check off for one run, even while connected:

```bash
npx -y zn-gate analyze --local-only "Summarize the changelog for the release notes."
```

`--local-only` (or `ZN_LOCAL_ONLY=true`) turns the cloud check off for that run. To turn it off for good:

```bash
npx -y zn-gate disconnect
```

This removes the saved key from this computer. It then asks whether to also revoke the key on usezn.com, so it stops working everywhere; the default is no, and only an explicit yes sends anything. Run `zn-gate status` again to confirm that the cloud check is off.

## If something fails

- **`connect` or `disconnect` refuses to run**: it only runs in a terminal you are typing in, never from an AI agent or a script.
- **The key is refused**: create an analysis-only key on the connect page, then run `zn-gate connect` again. Nothing was saved.
- **`fallback: true` in a result**: the cloud call failed and the local rules checked the prompt. Check your connection, and see [What is sent](../connect.md#what-is-sent) for what that means.

More in [Troubleshooting](../troubleshooting.md#7-zn-gate-connect-does-not-accept-your-key) and on the [connect page](../connect.md).
