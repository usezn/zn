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

- **A value read from an environment variable.** `curl -H "Authorization: Bearer $TOKEN" ...`, `${API_KEY}`, `$env:TOKEN` and `%TOKEN%` are the safe way to pass a secret, so they are not reported. Only a value written out in the command counts. If you want an agent to use a secret, put it in an environment variable (or in the zn vault and run the command with `zn run --secrets NAME -- <command>`) and refer to it by name.
- **Requests to your own machine.** `localhost`, `127.0.0.1` and `::1` are never checked.
- **Hosts you list** in `hooks.egressAllowHosts` (below).
- **An MCP call to such a host is still read for its other arguments.** For a local or listed host, the URL, headers and body of an MCP call are not checked, because they go to that host. The MCP server itself receives all the arguments, so personal data in any other text of the call (a note, a message) still asks, as it does for an MCP call that is not a web request.
- **Commands that only mention an address.** `git commit -m "reply to a@example.com"`, `git config user.email a@example.com` and `echo` are not network requests.
- **File uploads.** `curl -d @file.json` sends a file, and the check does not read it.

## What you see

When a request is flagged, your agent asks you to approve or refuse it. The message says what was found and where, and the host it goes to, never the value itself. For example:

> zn: this command would send an email address in a header to example.com. Approve it only if that data should leave this computer. To send a secret, read it from an environment variable (such as $API_TOKEN) instead of writing the value in the command.

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

Write the name of an environment variable, not the value:

```sh
curl -H "Authorization: Bearer $API_TOKEN" https://api.example.com/items
```

The shell fills in the value when the command runs, so the agent, the transcript and zn-gate never see it written in the command. For secrets the agent should never see, use the [vault](secrets.md) and `zn run --secrets NAME -- <command>`.

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
