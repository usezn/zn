# Network requests that carry personal data

An agent that reads a web page, an issue or a file can be tricked into sending your details to a server it was never meant to call. A known case: after a prompt injection, an agent put its user's name and email address into the headers of an HTTP request. zn-gate now looks at the network requests an agent writes **before they run**, and asks you first when one carries personal data or a literal secret.

It is on by default and it asks. It does not change anything else about the request.

## What is checked

| Where the request is written | Examples |
| --- | --- |
| Shell commands (Bash, PowerShell) | `curl`, `wget`, `Invoke-WebRequest`, `Invoke-RestMethod` and their aliases `iwr` and `irm` (and `curl` and `wget` in PowerShell) |
| Inline code in a shell command | `python -c`, a Python program fed from a here-document, `node -e`, `deno eval`, `bun -e` that call `requests`, `urllib`, `httpx`, `fetch`, `http`, `https` and similar, or contain a URL |
| The WebFetch tool | the URL |
| MCP tools that make web requests | any MCP call whose arguments hold a URL or headers |

In each request zn-gate reads the places where data leaves your computer:

- headers, including cookies, user agent and referer;
- credentials: `--user`, `-u`, `--oauth2-bearer`, `--password`, and the user and password of a URL;
- the query string and the rest of the URL;
- the body: `-d`, `--data*`, `--json`, `-F`, `--post-data`, and the same inside inline code.

Percent-encoded values are read too: `jane.doe%40example.com` in a URL or a form body is the email address `jane.doe@example.com`. A PowerShell command split over several lines with a backtick at the end of each line is read as one command. For an MCP call, every text in the arguments is read, including the ones that are not a URL, a header or a body.

It looks for the same things the zn-gate scrubber already finds:

- **personal data:** email addresses, phone numbers, bank account numbers (IBAN), card numbers, national ID numbers and social security numbers;
- **literal secrets:** API keys, tokens, private keys and passwords in URLs, plus any secret you stored in the zn vault.

## What it does not flag

- **A value read from an environment variable.** `$TOKEN`, `${API_KEY}`, `$env:TOKEN` and `%TOKEN%` are not literal values, so they are not reported. Only a value written out in the command counts. This is not a way to give an agent a secret: the shell expands the variable into the program's arguments, where the value shows in the process list and in command-line logs. To let an agent use a secret, put it in the zn vault and run the command with `zn run --secrets NAME -- <command>` (the program reads the variable itself), or use the `secrets_http_request` tool for web requests.
- **Requests to your own machine.** `localhost`, `127.0.0.1` and `::1` are never checked.
- **Hosts you list** in `hooks.egressAllowHosts` (below).
- **An MCP call to such a host is still read for its other arguments.** For a local or listed host, the URL, headers and body of an MCP call are not checked, because they go to that host. The MCP server itself receives all the arguments, so personal data in any other text of the call (a note, a message) still asks, as it does for an MCP call that is not a web request.
- **Commands that only mention an address.** `git commit -m "reply to a@example.com"`, `git config user.email a@example.com` and `echo` are not network requests.
- **File uploads.** `curl -d @file.json` sends a file, and the check does not read it.

## What you see

When a request is flagged, your agent asks you to approve or refuse it. The message says what was found and where, and the host it goes to, never the value itself. For example:

> zn: this command would send an email address in a header to example.com. Approve it only if that data should leave this computer. To use a secret, do not write its value in the command and do not expand a shell variable into its arguments: use the secrets_http_request tool for a web request (the secret in proxy mode), or `zn run --secrets NAME -- <program that reads the variable>` so the program reads the secret from its own environment variable.

Approve it only if you want that data to reach that server.

## Change the settings

Set `hooks.egressCheck` in `~/.zn/config.json`:

| Setting | What happens when a request carries personal data or a literal secret |
| --- | --- |
| not set, or `"ask"` | the agent asks you (the default) |
| `"deny"` | the request is refused and the agent is told to send it without the data |
| `"off"` or `false` | the check is off |

```json
{"hooks": {"egressCheck": "deny"}}
```

To skip hosts you trust, list them in `hooks.egressAllowHosts`. An entry is a host name (`api.example.com`) or a suffix with a star (`*.example.org`, which matches `svc.example.org` but not `example.org` itself):

```json
{"hooks": {"egressAllowHosts": ["api.example.com", "*.example.org"]}}
```

A request is skipped only when every host in it is local or on the list.

The environment variable `ZN_EGRESS_CHECK=deny` makes the check stricter (`ask` turns it back on if the file says `off`). The environment can only add protection, never remove it: `ZN_EGRESS_CHECK=off` is ignored. A project an agent works in can set environment variables, so turning the check off is only possible from the config file, which the agent's file tools cannot write (they cannot write to `~/.zn`).

## Passing a secret the safe way

Do not write the value in the request, and do not expand a variable into the command line either:

```sh
# Do not: the shell puts the value in the arguments of curl,
# where the process list and command-line logs show it
curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com/items
```

Instead, store the secret in the [vault](secrets.md) and let zn hand it over without it ever being written in a command:

- **A web request:** the agent calls the `secrets_http_request` tool with the marker in a header (`Bearer __ZN_API_TOKEN__`). zn makes the request and masks the response.
- **A program:** `zn run --secrets API_TOKEN -- <command>` gives the program the value as an environment variable, and the program reads that variable itself. Where the program can take the secret from standard input or a file, prefer that to an argument. Do not copy the variable into the arguments of another program, for example with `sh -c`.

## Limits

This reads the text of a command, a URL or the arguments of an MCP call. It is a guardrail, not a sandbox. It does **not** see:

- a request made by a script file the agent wrote and then runs (`python send.py`);
- a value the command builds at run time (a variable that holds an address, a value piped in from another command);
- requests made by other programs (`httpie`, `ssh`, `scp`, `git push`) or other languages;
- the body of a file you upload with `@file`.

It also depends on the scrubber: it reports what the scrubber can detect, so a name or an address that has no fixed format (a street, a first name) is not found, and neither is a bare password passed with `--user name:password` unless it looks like a credential the scrubber knows. MCP calls are checked in agents that send their arguments to the pre-tool check (see [Agent compatibility](compat.md)).

The Python package (`zn-gate` on PyPI) does not install hooks and has no personal-data detector, so this check is part of the Node.js hooks only.

## Cost

The check adds nothing to commands that are not network requests. For a network request, reading the command takes a few microseconds, and the scrubber engine is loaded the first time it is needed in that hook run.
