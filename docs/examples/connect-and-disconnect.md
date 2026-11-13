# Example: connect, check the status and disconnect

A short walk-through of the optional cloud check. Everything here is documented in [How it works](../connect.md), the [command reference](../cli.md) and [Troubleshooting](../troubleshooting.md). You do not need any of this to use zn-gate: without it everything stays on your machine.

Run the commands yourself, in your own terminal. When an AI agent runs `connect` or `disconnect`, or there is no terminal, they refuse and change nothing.

## 1. Connect

```bash
npx -y zn-gate connect
```

(or `zn-gate connect` if you installed it with `npm i -g zn-gate`).

1. The command tells you what will change and asks you to confirm.
2. It opens <https://usezn.com/connect/> in your browser. Create a free account (or log in) and create an analysis-only API key there.
3. Back in the terminal, paste the key at the hidden prompt. Nothing you type is shown. A key looks like `zn_` followed by 48 characters, for example `zn_` followed by placeholder characters. Never type a real key into an example, a note or the command line.
4. zn-gate checks the key once with <https://api.usezn.com>. It accepts only an analysis-only key. A full-access key, a key the server rejects and a key that could not be checked are all refused, and nothing is saved.
5. The key is saved in your system keychain, or in the zn vault when there is no keychain (unlock it with `zn unlock`). It is never saved in a plain file. The command prints the last four characters so you can recognise the key.

Exit code `0` means connected (or already connected). `1` means nothing was saved. `2` means the command was used wrongly, for example the key was put on the command line.

If you are already connected, `connect` says so and changes nothing. To replace the saved key:

```bash
npx -y zn-gate connect --reconnect
```

## 2. Check the status

```bash
npx -y zn-gate status
```

It shows the version, the rules version, whether the cloud check is on and where the key comes from (`ZN_API_KEY`, `--key`, the keychain or the vault). It never shows the key and always exits `0`.

From now on, the `analyze_prompt` tool and `zn-gate analyze` also send the text, with detected secrets hidden first, to the classifier at usezn.com. Hooks, file and secret protection and every other command stay local. If the cloud call fails, the prompt is checked by the local rules alone.

To keep the check off for one run even while connected, use `--local-only` (or set `ZN_LOCAL_ONLY=true`).

## 3. Disconnect

```bash
npx -y zn-gate disconnect
```

This turns the cloud check off and removes the saved key from this computer. It then asks whether to also revoke the key on usezn.com, so it stops working everywhere. The default is no, and only an explicit yes sends anything.

Two options skip the question:

```bash
npx -y zn-gate disconnect --revoke
npx -y zn-gate disconnect --no-revoke
```

`--revoke` revokes without asking. `--no-revoke` only removes the local copy and makes no network call. The local copy is removed in every case, even if a revoke request fails. In that case the command says so, and you can revoke the key yourself at <https://usezn.com/api-keys/>.

Exit code `0` means the local setting was removed (or there was nothing to remove). `1` means something was not done (no terminal, the vault is locked, or a revoke you asked for did not happen). `2` means the command was used wrongly.

Run `npx -y zn-gate status` again to confirm that the cloud check is off.

## If something fails

- **It refuses to run:** open your own terminal and run it there, not through an AI agent or a script.
- **The key is refused:** create an analysis-only key on the connect page and run `connect` again.
- **usezn.com cannot be reached:** nothing was saved. Check your connection and try again.
- **The computer has no keychain and the vault is locked:** run `zn unlock`, then `connect` again.

More in [Troubleshooting](../troubleshooting.md#7-zn-gate-connect-does-not-accept-your-key).
