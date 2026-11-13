# Example: running offline and with the cloud check off

A short walk-through of how to use zn-gate with no network and with the optional cloud check off. For the full behaviour, read the [command line reference](../cli.md), [Turn on the optional cloud check](../connect.md) and the [egress check](../egress-check.md).

## The default: nothing leaves your machine

zn-gate works fully on your computer, needs no account and sends nothing. The cloud check is optional and is off unless you turn it on with `ZN_CLOUD=1` or `zn-gate connect`. Hooks, file and secret protection, the shield and every other command stay local and never use it. Only `analyze` and `analyze_prompt` can use it.

The self-test never uses the network:

```sh
zn-gate test
```

It exits `0` when all built-in examples pass and `1` when at least one fails.

## Keep the cloud check off, even if it is set

`ZN_LOCAL_ONLY=true` or `--local-only` means the cloud is never used, even when `ZN_CLOUD=1` is set:

```sh
ZN_CLOUD=1 ZN_API_KEY=example-fake-key ZN_LOCAL_ONLY=true zn-gate analyze "some text"
```

The same setting turns the cloud check off when you are already connected with `zn-gate connect`. The `--local-only` option has the same effect as the variable.

## Check and change the state

```sh
zn-gate status
```

shows whether a key is connected and where it comes from, never the key. To remove the key from this computer and turn the cloud check off:

```sh
zn-gate disconnect --no-revoke
```

`--no-revoke` never revokes the key and makes no network call. Plain `zn-gate disconnect` may ask whether to also revoke the key on usezn.com; only an explicit yes sends anything. Both `connect` and `disconnect` run only in your own terminal.

## What about the egress check?

The [egress check](../egress-check.md) reads the commands an agent writes before they run. Requests to your own machine, such as `http://localhost:8080/items`, are never checked. For its settings and limits, read the full page.

## Further reading

- [Command line reference](../cli.md), section Settings
- [Turn on the optional cloud check](../connect.md)
- [Network requests that carry personal data](../egress-check.md)
