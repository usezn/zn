# Protect MCP servers: shield, shadow mode and tool pins

`zn-gate shield` is a local proxy that sits between your agent and an MCP server. You wrap a server once, and every message between the agent and that server passes through zn-gate on your machine. Nothing is sent anywhere: the checks on tool lists, tool-call arguments and tool output run locally in every configuration.

For each wrapped server the shield:

1. **Checks the tool list.** Tool and parameter descriptions that carry hidden instructions are neutralized before the agent reads them.
2. **Checks tool-call arguments.** A call whose arguments carry an injection is refused and never reaches the server.
3. **Checks tool output.** Secrets are redacted, and output that carries an injection is replaced by a short notice.
   The same check covers the other text the server sends to the agent: notifications, requests such as sampling, resource and prompt contents (text blobs too), the descriptions in resource and prompt lists, the initialize instructions, completion values, error messages, and the structured content, embedded resources and resource links of tool results. A line from the server that is not valid JSON is dropped (shadow mode passes it on and reports it). JSON-RPC batches are checked message by message in both directions.
4. **Pins the tools.** It remembers what each tool looked like the first time and flags any tool that changes later (see [Tool pinning](#tool-pinning)).
5. **Records each decision** in the local audit log (`~/.zn/evidence.jsonl`; check it with `npx -y zn-gate evidence --verify`, and see [how the log works](architecture.md)).

## Wrap one server: `shield`

Put zn-gate in front of the command that starts the server, and separate the two with `--`:

```bash
npx -y zn-gate shield -- uvx mcp-server-fetch
npx -y zn-gate shield -- npx -y @modelcontextprotocol/server-postgres postgresql://localhost/db
```

In an agent's MCP configuration, set the command to `npx` and put `-y zn-gate shield --` before the original command and arguments. For example, a server configured as `uvx mcp-server-fetch` becomes:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "zn-gate", "shield", "--", "uvx", "mcp-server-fetch"]
    }
  }
}
```

`mcp-shield` and `wrap` are other names for the same command. Always use `--`: without it, zn-gate takes the words after `shield` that do not start with `--` as the command, which is easy to get wrong. If you give no command, `shield` prints a usage message and exits with code 1.

`--verbose` prints what the shield does (each request it inspects and each redaction) to stderr. In an agent app, stderr goes to the app's MCP log, not to your terminal.

## Wrap all your servers at once: `init --wrap-mcp`

`init --wrap-mcp` finds the MCP servers in the configuration files of the agents on your machine (Claude Desktop, Claude Code, Cursor, Codex CLI, OpenCode, Antigravity and Hermes), writes a backup of each file it changes, and rewrites each local (stdio) server as a `shield` command.

```bash
# Preview what would change, and change nothing
npx -y zn-gate init --dry-run

# Wrap in shadow mode first
npx -y zn-gate init --shadow

# Wrap and enforce
npx -y zn-gate init --wrap-mcp

# Restore the original files from the backups
npx -y zn-gate init --revert
```

Servers that run at a URL (remote servers) are left as they are, because the shield can only wrap a program it starts. A file that zn-gate cannot rewrite safely (for example an OpenCode file with comments) is reported as "wrap manually"; use `shield` by hand for those servers.

## Shadow mode: log without blocking

`--shadow` makes the shield watch and record, but not change anything. Use it for the first days with a new server, to see what zn-gate would have done before you let it act.

```bash
npx -y zn-gate shield --shadow -- uvx mcp-server-fetch
npx -y zn-gate init --shadow
```

Put `--shadow` before the `--` that starts the server command. `init --shadow` writes the flag into the wrapped command for you.

In shadow mode:

- A tool call that would be refused is still forwarded to the server, and the shield writes a `[zn-shield BLOCKED REQUEST]` line to stderr.
- Tool descriptions and parameter descriptions that would be neutralized are left as the server sent them.
- Tool output is forwarded untouched: no secret is redacted and no output is replaced. This is the one place where shadow mode lets a secret reach the agent, so use it to evaluate, not as a protection.
- Tool pinning still detects changes and logs them, but it does not mark, remove or refuse any tool, whatever the pinning mode is.
- Every detection is written to the audit log.

Review what the shield found with:

```bash
npx -y zn-gate evidence --tail 20
```

When the log looks right, run `init --wrap-mcp` (or remove `--shadow` from the command) to enforce.

## Tool pinning

A server can change a tool after you started using it, for example a new description that tells the agent to send files somewhere, or a new parameter. Tool pinning catches that.

### What gets pinned

The first time the shield sees the tool list of a server, it records a fingerprint (a SHA-256 hash) of each tool definition. The fingerprint covers the whole tool object (name, description, input schema and any other field), so a change to any part of a tool changes its fingerprint. Every later tool list from that server is compared with the pinned fingerprints.

A tool is flagged when:

- its definition is different from the pinned one;
- it is new, which means it was not in the pinned list;
- the server lists more than one tool with the same name, or a tool without a valid name. These can never be approved: the server has to fix its tool list.

A tool that disappears from the list is not flagged. If a flagged tool goes back to its pinned definition, the flag clears by itself.

The first list a server returns is trusted as it is (trust on first use). Servers that return the list in several pages are pinned page by page during that first run.

Pins belong to a server's command line. A server key is computed from the program and its arguments, so a changed command line (for example a new package version, or `node server.js` in another project) is a different server, and its first list is trusted again.

### Modes

| Mode | What happens to a changed or new tool |
| --- | --- |
| `warn` (default) | The tool stays usable. Its description starts with a notice that tells the agent to ask you before using it, and the shield writes a `[zn-shield TOOLS CHANGED]` line to stderr. This relies on the agent reading the notice. |
| `block` | The tool is removed from the list, and any call to a tool that is not approved is refused with an error, even when the agent calls it from a list it saved earlier. Use this mode when you want a hard stop. |
| `off` | No pinning. |

Every change is also written to the audit log. Tools flagged as duplicate or without a name are removed in `block` mode and reported in both modes.

Set the mode in `~/.zn/config.json`:

```json
{ "mcpPinning": "block" }
```

or for one run with the environment variable `ZN_MCP_PINNING=block`. The mode that applies is the strictest of the two. An MCP server's environment can make pinning stricter but never weaker: only `"mcpPinning": "off"` in your own `~/.zn/config.json` turns it off. With `--shadow`, pinning only logs (see above).

### See the pins

```bash
npx -y zn-gate pins
```

lists each pinned server with its key, its command line, how many tools are pinned and when, and the names of the tools that changed or are new since then. `zn-gate pins list` does the same. If nothing is pinned yet, it says so; servers are pinned the first time the shield sees their tools.

### Approve a change

When the shield reports `[zn-shield TOOLS CHANGED]`, first look at the tool: open it in your agent, or read the server's source or changelog. `pins` shows tool names, not their text. If you accept the change, run in your own terminal:

```bash
# One server: use the key that `pins` prints
npx -y zn-gate pins approve <server-key>

# Every server with pending changes
npx -y zn-gate pins approve --all
```

zn-gate asks you to type the server key (or `all`) again before it approves. After approval the changed and new tools are pinned as the shield last saw them, and they work again the next time the agent lists the server's tools. If a tool changes again later, it is flagged again.

Approval is your decision, not your agent's, so it is refused:

- when the command runs under an AI agent (zn-gate looks at the agent's environment variables and at the programs that started it);
- when there is no interactive terminal;
- when the agent's hooks see the command in a tool call.

If what you typed does not match, nothing changes and you can run the command again.

### What happens when a tool changes

1. The agent asks the server for its tools. The shield compares the list with the pins and flags the changed tool.
2. In `warn` mode the agent sees the tool with a notice in front of its description. In `block` mode the tool is not in the list, and a call to it returns an error that tells the agent to ask you to review the tool and run `zn-gate pins approve` in your own terminal.
3. The shield writes `[zn-shield TOOLS CHANGED] <tools>: new or changed since the tools of this server were approved` with the exact command to run, and records the event in the audit log.
4. You review the tool and either run `pins approve`, or remove the server.

If the pins file of a server cannot be read or written, the shield treats every tool of that list as unapproved until the pins work again, and says so on stderr. A corrupt pins file is moved aside (`.corrupt-<time>`) and never trusted again silently.

### What is stored

Pins live in `~/.zn/mcp-pins/`, one file per server, readable only by your account on Linux and macOS. Each file holds the program name, its arguments with secrets removed, and the tool names with their fingerprints. It never holds tool text.

## Limits

- Pinning covers tool definitions (names, descriptions and parameters). It does not check the server's code.
- Tool results are checked in full up to 32 MB. A larger result is removed and the agent is told to ask the tool for a smaller part (a page or a line range).
- Text nested more than 8 levels deep in a server message or in a tool result's structured content is not checked. It is replaced by a notice, so the agent does not get it unchecked; in shadow mode it is passed on unchanged, and the shield writes one line to stderr saying the message was not fully checked.
- Lines are capped before they are read in full: a line over 64 MiB from the server (32 MiB from the client) is dropped, in shadow mode too, because it cannot be held in memory to be checked. A message nested more than 128 levels, with more than 4 million values, or in a batch of 1000 messages or more is refused with a JSON-RPC error; when the server sends such a batch, each request it was answering gets its own error. While a lot of server output waits to be checked, the shield stops reading from the server.
- At most 5000 requests can wait for an answer from the server at once. The next tool call or tool list is refused with an error until the server answers or the agent cancels one (shadow mode sends it on without tracking it). A tool list that answers no waiting request is not passed on.
- `ZN_SHIELD_LIMITS` can lower these limits. Set it in the `env` of the wrapped command as a JSON object with any of `serverLineBytes`, `clientLineBytes`, `depth`, `elements`, `batch`, `pending` and `queueHighWater`, for example `ZN_SHIELD_LIMITS='{"pending":500}'`. Values must be positive integers; a value above the default is cut to the default.
- The first list a server returns is trusted. If that list was already harmful, pinning does not catch it.
- A server started as `npx some-tool@latest` can change its code while its tool list stays the same. Pin the package version in your MCP configuration, for example `npx -y some-tool@1.4.2`, and review each new version.
- An agent that can run commands on your machine could edit the pin files or start a server without the shield. The hooks stop the commands they recognize, not every possible one.
- Pinning protects only servers that run through `zn-gate shield`. Remote (URL) servers are not covered.
- The checks look at what goes in and out of a tool. They do not decide which tools an agent should have. After wrapping, keep only the tools your agent needs and put destructive operations behind explicit approval.

More: [Protect MCP servers on usezn.com](https://usezn.com/docs/zn-gate/shield), [what zn-gate cannot do](threat-model.md), [how the audit log works](architecture.md).
