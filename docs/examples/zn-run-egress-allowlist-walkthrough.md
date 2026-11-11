# Example: run a command behind the egress allowlist

A short walk-through of `zn run --egress-allow`. It lets one command reach only the hosts you list, over HTTP and HTTPS, through a local proxy that zn starts for that command and stops when the command ends. The hosts and values here are made up: a local address (`127.0.0.1`) and reserved names. For the full behaviour and its limits, read [Egress allowlist for `zn run`](../secrets.md#egress-allowlist-for-zn-run) in the secrets guide.

The allowlist is off by default. A command started without `--egress-allow` runs as before, with no proxy.

You run these commands in your own terminal. None of the steps below uses a secret, so none needs the vault.

## 1. Decide which hosts the command may reach

`--egress-allow` takes a comma-separated list of `HOST` or `HOST:PORT` entries:

- `api.example.com` allows that exact host on every port.
- `api.example.com:443` allows that host on port 443 only.
- An IP address works the same way, for example `192.0.2.10:443`.
- A name matches only itself. `api.example.com` does not allow `x.api.example.com`.
- Wildcards such as `*.example.com` are refused (step 6).

## 2. Start a local server for the allowed path

This walkthrough does not contact a real host. Start a small server on your own machine in a second terminal and keep it running. Stop it with Ctrl+C when you are done.

```bash
node -e "require('http').createServer((q, s) => s.end('local-ok\n')).listen(8080, '127.0.0.1')"
```

## 3. Run an allowed request

```bash
npx -y zn-gate run --egress-allow 127.0.0.1:8080 -- curl -sS http://127.0.0.1:8080/
```

The output is `local-ok`, and the exit code is `0`.

Before the command starts, zn opens a proxy on a random port on `127.0.0.1` and points the command at it. It sets `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY` (and the lowercase forms), and sets `NODE_USE_ENV_PROXY=1`. It removes `NO_PROXY`, so the command cannot skip the proxy with it. The proxy opens a connection only to the hosts on the list.

## 4. Refused plain HTTP request

```bash
npx -y zn-gate run --egress-allow 127.0.0.1:8080 -- curl -sS http://192.0.2.10/
```

The error output shows that zn refused the host:

```text
zn run: egress refused 192.0.2.10:80 (not in --egress-allow)
```

curl prints the answer the proxy sent back:

```text
zn run egress proxy: host not in --egress-allow
```

The exit code is `0`, because curl without `-f` prints the body of a 403 and exits normally. The command's own exit code is what `zn run` returns. zn refuses the host before any DNS lookup, so the address `192.0.2.10` is never contacted.

## 5. Refused HTTPS request

```bash
npx -y zn-gate run --egress-allow 127.0.0.1:8080 -- curl -sS https://api.example.invalid/
```

```text
zn run: egress refused api.example.invalid:443 (not in --egress-allow)
curl: (7) CONNECT tunnel failed, response 403
```

The exit code is `7`, which is curl's code. For HTTPS the proxy sees only the host name and the port in the connection request. It does not see the request, the headers or the body.

## 6. Mistakes in the list

An entry that is not a host name or an IP address stops the command before it starts:

```bash
npx -y zn-gate run --egress-allow '*.example.com' -- curl -sS http://x.example.com/
```

```text
zn run: invalid --egress-allow entry "*.example.com". --egress-allow takes HOST or HOST:PORT, comma separated (for example api.example.com,api.example.org:8443)
```

A missing value stops it in the same way, and prints the usage line:

```text
zn run: usage: zn run [--secrets NAME[,NAME...]] [--agent ID] [--egress-allow HOST[:PORT],...] -- <command> [args...]
```

Both exit with code `64`, and the command does not run.

## 7. Right host, wrong port

Allow a port that the command does not use:

```bash
npx -y zn-gate run --egress-allow 127.0.0.1:8081 -- curl -sS http://127.0.0.1:8080/
```

zn logs `zn run: egress refused 127.0.0.1:8080 (not in --egress-allow)`, the proxy answers 403, and the exit code is `0`, as in step 4. The entry `127.0.0.1:8081` allows port 8081 only.

## 8. Program not found

```bash
npx -y zn-gate run --egress-allow 127.0.0.1:8080 -- nosuchprogram-example
```

```text
zn run: Not found: `nosuchprogram-example` is not installed, or it is not on your PATH. Next step: check that the program is installed and on your PATH.
```

The exit code is `127`.

## Exit codes

| Exit code | When you see it |
|---|---|
| The command's own code | The command ran. `0` for success; `7` in step 5 is curl's code for a failed tunnel. |
| `64` | The `--egress-allow` value is invalid or missing. The command did not start. |
| `1` | Another error, for example zn could not start the proxy. |
| `127` | The program after `--` was not found. |

These match the table in [exit codes](../exit-codes.md#secrets-and-the-vault).

## What the allowlist does not cover

- A program that ignores the proxy variables is not limited. Raw sockets and DNS lookups the program makes itself are not limited either.
- Node reads the proxy variables only in versions that honour `NODE_USE_ENV_PROXY`. Older versions of Node connect directly and are not covered. See [the full page](../secrets.md#egress-allowlist-for-zn-run).
- An allowed name is trusted to resolve to where it should. The proxy does not check the address the name resolves to.
- It is a guard for well-behaved tools, not a sandbox.

Three settings have similar names but do different things:

- `hooks.egressAllowHosts` in the config file exempts hosts from the personal-data check of the agent's network request hook. It does not change what `zn run` allows. See [Network requests that carry personal data](../egress-check.md).
- `zn secret allow NAME --host` sets the hosts that `secrets_http_request` may send a secret to. `zn run --egress-allow` does not read that list.
- `--egress-allow` is the only setting that limits the network for a command started with `zn run`.

## Using it with a secret (not run here)

`--egress-allow` can be combined with `--secrets`. zn fills in the secret first and then sets the proxy variables, so the program gets both. This needs an unlocked vault, and the first use of a secret asks you to confirm in the vault's own dialog or terminal. For that reason it was not run for this walkthrough. See [Store a secret and run a program that uses it](secret-set-and-run.md) for that flow.

## Clean up

Stop the local server from step 2 with Ctrl+C. Nothing else is left behind: the proxy closes when the command ends.
