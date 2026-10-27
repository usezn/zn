# Example: egress check with fake hosts

A short walk-through of the [egress check](../egress-check.md). All hosts and values here are fake and use reserved domains. For the full behaviour, settings and limits, read the [full page](../egress-check.md).

## A request that is flagged

An agent writes this command, with an email address in a header:

```sh
curl -H "X-User: jane.doe@example.com" https://api.example.com/items
```

Before it runs, zn-gate asks you to approve or refuse it. The message names what was found and the host, never the value:

> zn: this command would send an email address in a header to api.example.com. Approve it only if that data should leave this computer.

Percent-encoded values are read too, so this is flagged the same way:

```sh
curl "https://api.example.com/items?user=jane.doe%40example.com"
```

## Requests that are not flagged

A secret read from an environment variable is the safe way to pass it, so this is not reported:

```sh
curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com/items
```

Requests to your own machine are never checked:

```sh
curl -d "a=jane.doe@example.com" http://localhost:8080/items
```

Commands that only mention an address are not network requests:

```sh
git config user.email jane.doe@example.com
```

## Skip a host you trust

List it in `hooks.egressAllowHosts` in `~/.zn/config.json`. A star matches subdomains (`svc.example.org`) but not `example.org` itself:

```json
{"hooks": {"egressAllowHosts": ["api.example.com", "*.example.org"]}}
```

A request is skipped only when every host in it is local or on the list.

## Refuse instead of asking

```json
{"hooks": {"egressCheck": "deny"}}
```

The request is refused and the agent is told to send it without the data.
