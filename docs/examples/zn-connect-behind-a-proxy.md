# Example: the cloud check behind a corporate proxy

How to use the optional cloud check ([`zn-gate connect`](../connect.md)) on a network that sends web traffic through a proxy. All hosts and values here are fake: `proxy.example.com`, `192.0.2.10` and keys that are placeholders.

The short version, said plainly:

- zn-gate's own code in the npm package does **not** read `HTTPS_PROXY`, `HTTP_PROXY` or `NO_PROXY`. It has no proxy setting of its own.
- Node.js itself can send requests through a proxy when you start it with `NODE_USE_ENV_PROXY=1`. That is a Node.js feature, not a zn-gate one.
- The Python package uses Python's standard library, which reads `HTTPS_PROXY` by itself. The Python package has no `connect` command.
- If the proxy cannot be used, nothing breaks: the local checks keep working and the result says the cloud call did not happen.

Everything here is optional. zn-gate works fully on your computer without the cloud check. See [offline and local only](offline-and-local-only.md).

## What the cloud check needs from the network

The cloud check talks to one host: `api.usezn.com`, over HTTPS on port 443. `connect` also opens <https://usezn.com/connect/> in your browser, and your browser uses its own proxy settings for that. Ask your network team to allow `api.usezn.com` on port 443 through the proxy. Nothing else is needed.

## Node.js: turn on Node's own proxy support

Set the proxy and the Node.js switch in the terminal where zn-gate runs. The proxy URL below is made up:

```bash
export HTTPS_PROXY=http://proxy.example.com:3128
export NODE_USE_ENV_PROXY=1
```

An address works the same way: `export HTTPS_PROXY=http://192.0.2.10:3128`.

Without `NODE_USE_ENV_PROXY=1`, the variable `HTTPS_PROXY` has no effect on zn-gate: the request goes straight out and a network that blocks direct connections makes it fail. The switch needs a recent Node.js. The [secrets page](../secrets.md) says it was tested on Node.js 22.21 and later 22.x, and on 24.5 and later; run `node --help` and look for `--use-env-proxy` to see whether your version has it.

### What was tested

The request of the cloud check was run three ways, with a listener on `127.0.0.1` standing in for the proxy and the reserved host `example.invalid` in place of the service, so no request reached a real server. Node.js was 24.22.1.

| Run | What the listener saw | `cloud_error` in the result |
| --- | --- | --- |
| `HTTPS_PROXY` only | nothing | `getaddrinfo ENOTFOUND example.invalid` (a direct lookup, the proxy was ignored) |
| `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` | `CONNECT example.invalid:443 HTTP/1.1` | `Failed to establish tunnel to example.invalid:443 via http://127.0.0.1:18099: HTTP/1.1 502 Bad Gateway` |
| Python package, `HTTPS_PROXY` only | `CONNECT example.invalid:443 HTTP/1.1` | `<urlopen error Tunnel connection failed: 502 Bad Gateway>` |

This was run with `zn-gate analyze`. The `connect` command makes its requests with the same Node.js `https` module, but it needs a person at a terminal, so it was not run through a proxy in this test.

## A proxy that replaces the certificate

Some company proxies open the encrypted connection and sign it with the company's own certificate. Node.js then needs that certificate through `NODE_EXTRA_CA_CERTS`. zn-gate will not send the key it saved over such a connection, because someone could read it. In this case `connect` stops before it saves anything, and names the variable:

- `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `OPENSSL_CONF`, `NODE_DEBUG`, `NODE_TLS_REJECT_UNAUTHORIZED=0` and some `NODE_OPTIONS` values all count. The list and the sentence you see are in [troubleshooting, section 8](../troubleshooting.md#8-will-not-send-the-saved-key-tls-settings).
- Your local checks keep working while this is the case.
- Do not turn off certificate checks to make the message go away.

What does work is a key you give yourself. The proxy can read that key too, so give it only an analysis-only key, never another one. Create an analysis-only key on <https://usezn.com/connect/> in your browser, then set it in your shell. A key set this way is your own choice and is not held back, and Node.js trusts `NODE_EXTRA_CA_CERTS` for it ([Troubleshooting](../troubleshooting.md) says the same, under the certificate section):

```bash
export ZN_CLOUD=1
export ZN_API_KEY='paste-your-analysis-only-key-here'
export NODE_EXTRA_CA_CERTS=/path/to/company-ca.pem
zn-gate analyze "Summarize the quarterly report."
```

This was run with a placeholder key and the reserved host `example.invalid`: no refusal came back, and the request failed only because that host does not exist. Ask your administrator for the real path of the company certificate file.

This route is for `zn-gate analyze` and the `analyze_prompt` tool, as described on the [connect page](../connect.md). While one of those variables is set, a key kept in your keychain by `connect` is not sent.

## Python: nothing extra to set

The Python package reads `HTTPS_PROXY` through the standard library. Set it, then give the key in the shell as above:

```bash
export HTTPS_PROXY=http://proxy.example.com:3128
export ZN_CLOUD=1
export ZN_API_KEY='paste-your-analysis-only-key-here'
zn-gate analyze "Summarize the quarterly report."
```

Python uses your operating system's certificate list, and follows `SSL_CERT_FILE` and `SSL_CERT_DIR`. `zn-gate connect` is not a Python command: run it with `npx -y zn-gate connect`, as the message `zn-gate connect is a command of the npm package, not of this Python package.` says.

## What a failed cloud check looks like

`zn-gate status` only reads settings, so it does not show a failure. It shows whether the cloud check is on, the endpoint, and where the key comes from. See the [command reference](../cli.md#status).

A failed call shows up in the result of the check itself. In `zn-gate analyze` the JSON says `"fallback": true` and `"mode": "oss-local"`, and `cloud_error` holds the text of the error:

```json
{
  "verdict": "allow",
  "mode": "oss-local",
  "fallback": true,
  "cloud_error": "getaddrinfo ENOTFOUND example.invalid"
}
```

The text of `cloud_error` is the error Node.js or Python reported, so it changes with the cause: a name that cannot be found, a refused tunnel, a timeout. The text was checked by the local rules alone. Nothing is blocked because the cloud call failed. With `ZN_VERBOSE=1` the Node.js package also prints a warning on the error output:

```text
[zn-gate] Warning: Cloud gate error (getaddrinfo ENOTFOUND example.invalid). The cloud service could not be reached: check your network connection and ZN_API_URL. The local rules were used instead, so the text was checked on this machine only.
```

The check waits 4 seconds for an answer, and 12 seconds for a text of more than 1,000 characters. `connect` waits 8 seconds. When `connect` cannot reach the service, it saves nothing and prints:

```text
Could not reach usezn.com, so the key was not checked and nothing was saved. Check your internet connection, then run `zn-gate connect` again.
```

## Keep everything local

If the proxy cannot be made to work, turn the cloud check off for a run with `--local-only` (or `ZN_LOCAL_ONLY=true`), or for good:

```bash
zn-gate disconnect
```

It removes the saved key from this computer and then asks whether to also revoke it on usezn.com. Over a proxy that blocks `api.usezn.com`, that question can fail; the local copy is removed either way. See [connect](../connect.md#see-and-change-the-state).

## If something fails

- **`connect` names an environment variable and saves nothing**: see [the certificate section above](#a-proxy-that-replaces-the-certificate).
- **`connect` says it could not reach usezn.com**: the request did not get out. For the npm package, check that `NODE_USE_ENV_PROXY=1` is set together with `HTTPS_PROXY`, and that the proxy allows `api.usezn.com` on port 443.
- **`fallback: true` in a result**: the cloud call failed and the local rules answered. Read `cloud_error` for the cause.
- **Your Node.js ignores `NODE_USE_ENV_PROXY`**: it is too old for the switch. Update Node.js, or use the Python package for the cloud check.

## More

More in [Troubleshooting](../troubleshooting.md) and on the [connect page](../connect.md).
