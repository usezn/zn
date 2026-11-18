# Protect MCP servers: shield, shadow mode and tool pins

`zn-gate shield` is a local proxy that sits between your agent and an MCP server. You wrap a server once, and every message between the agent and that server passes through zn-gate on your machine. Nothing is sent anywhere: the checks on tool lists, tool-call arguments and tool output run locally in every configuration.

For each wrapped server the shield:

1. **Checks the tool list.** Tool and parameter descriptions that carry hidden instructions are neutralized before the agent reads them.
2. **Checks tool-call arguments.** A call whose arguments carry an injection is refused and never reaches the server.
3. **Checks tool output.** Secrets are redacted, and output that carries an injection is replaced by a short notice.
   The same check covers the other text the server sends to the agent: notifications, requests such as sampling, resource and prompt contents (text blobs too), the descriptions in resource and prompt lists, the initialize instructions, completion values, error messages, and the structured content, embedded resources and resource links of tool results. A line from the server that is not valid JSON is dropped (shadow mode passes it on and reports it). A line from the agent that is not valid JSON (for example one with `NaN`) is not sent to the server either, because it cannot be checked; the agent gets a parse error when the line has a readable request id, and shadow mode passes it on and reports it. JSON-RPC batches are checked message by message in both directions.
4. **Pins the tools.** It remembers what each tool looked like the first time and flags any tool that changes later (see [Tool pinning](#tool-pinning)).
5. **Records each decision** in the local decision log (`~/.zn/evidence.jsonl`; check it with `npx -y zn-gate evidence --verify`, and see [how the log works](architecture.md)).

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

`mcp-shield` and `wrap` are other names for the same command. Always use `--`: without it, zn-gate takes the words after `shield` that do not start with `--` as the command, which people often get wrong. If you give no command, `shield` prints a usage message and exits with code 1.

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
- Every detection is written to the decision log.

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

Every change is also written to the decision log. Tools flagged as duplicate or without a name are removed in `block` mode and reported in both modes.

Set the mode in `~/.zn/config.json`:

```json
{ "mcpPinning": "block" }
```

or for one run with the environment variable `ZN_MCP_PINNING=block`. The mode that applies is the strictest of the two. An MCP server's environment can make pinning stricter but never weaker: only `"mcpPinning": "off"` in your own `~/.zn/config.json` turns it off. With `--shadow`, pinning only logs (see above).

### Tool shadowing

When you wrap more than one server, the shield also compares each tool list with the approved tools of your other pinned servers and warns (`[zn-shield TOOL SHADOWING]`) in four cases:

- a tool has the same name as an approved tool of another server, so the agent may call the wrong one;
- the name of a tool reads like that of an approved tool of another server once case, full-width letters, look-alike letters of other alphabets and invisible or default-ignorable characters are set aside;
- the description, title, annotation title or the input or output schema of a tool names an approved tool of another server, also in the form `mcp__<server>__<tool>` or with invisible characters inside the name, which is how a server can steer how a different server's tool is used. Names shorter than six characters, names that are a single plain word (`update`, `commit`: they are in every text) and names that only appear inside a longer word are ignored for this check.
- the text of a tool is over 1 MiB, so it is reported as too long to check in full and the shield cannot check it for names of other servers' tools; read it yourself.

This is a warning, not a block: the same name on two servers can be legitimate. Each overlap is reported once per run of the shield, and it is logged in the decision log (`mcp_tool_shadowing`) without any tool text. A tool that is new or changed on the other server and not yet approved is not used as a reference.

### See the pins

```bash
npx -y zn-gate pins
```

lists each pinned server with its key, its command line, how many tools are pinned and when, and the names of the tools that changed or are new since then, each with what changed: its description, its parameters (the input and output schema, including every parameter description), other fields (annotations and the like), or `new tool`. `zn-gate pins list` does the same. Pins written by an older version say `whole tool` until the next approval. If nothing is pinned yet, it says so; servers are pinned the first time the shield sees their tools.

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
A worked example of this decision, with one new tool denied in block mode and the error the agent sees, is in [deny one MCP tool with the shield](examples/shield-deny-rule-example.md).

### What happens when a tool changes

1. The agent asks the server for its tools. The shield compares the list with the pins and flags the changed tool.
2. In `warn` mode the agent sees the tool with a notice in front of its description. In `block` mode the tool is not in the list, and a call to it returns an error that tells the agent to ask you to review the tool and run `zn-gate pins approve` in your own terminal.
3. The shield writes `[zn-shield TOOLS CHANGED] <tools>: new or changed since the tools of this server were approved` with the exact command to run, and records the event in the decision log.
4. You review the tool and either run `pins approve`, or remove the server.

If the pins file of a server cannot be read or written, the shield treats every tool of that list as unapproved until the pins work again, and says so on stderr. A corrupt pins file is moved aside (`.corrupt-<time>`) and never trusted again silently.

### What is stored

Pins live in `~/.zn/mcp-pins/`, one file per server, readable only by your account on Linux and macOS. Each file holds the program name, its arguments with secrets removed, and the tool names with their fingerprints (one for the whole tool and one each for its text, its parameters and its other fields). It never holds tool text.

## What the shield messages mean

The shield prints its messages on stderr, which your agent or editor shows in its log for the MCP server. Each starts with a label in square brackets. Texts are copied as zn-gate prints them; a part in angle brackets is a blank that zn fills in. A name after `Rule:` says what kind of text it was (see [the rules table](troubleshooting.md#what-a-rule-name-means)). In shadow mode the shield only reports and passes the text on.

| Label and text | Cause | What to do |
|---|---|---|
| `[zn-shield BLOCKED REQUEST] Prompt injection detected in arguments for tool '<tool>'. Rule: <rule>` | Your agent was about to send a tool call whose arguments carry text that tries to give orders. The call was not sent. | Find out where the agent got that text (a web page, a file, another tool). Do not retry with reworded text. |
| `[zn-shield BLOCKED REQUEST] A message from the client was not sent ...`, `A line from the client that is not valid JSON was not sent ...`, `A batch from the client holds something that is not a message ...` | A message from your agent was too large, too deeply nested, not valid JSON or a malformed batch, so it could not be checked. | Usually a bug in the agent or a very large call. Send less data in one call. |
| `[zn-shield BLOCKED TOOL DESCRIPTION] Poisoned tool description in '<tool>'. Rule: <rule>` | The server's description of a tool carries an injection. The tool's text was neutralized. | Do not trust that server. Remove it, or ask its author. |
| `[zn-shield BLOCKED PARAMETER DESCRIPTION] Poisoned parameter '<label>' in tool '<tool>'. Rule: <rule>` | A parameter name or description of a tool carries an injection. | Same as above. |
| `[zn-shield BLOCKED TOOL] Tool '<tool>' has an ... with a name, key or other schema string that carries a prompt injection, so it was not passed on.` and `... too deep or too large for zn-gate to check (limit: 32 levels or 5000 entries), so it was not passed on unchecked.` | A tool's schema carries an injection, or it is too big to check. The tool was not passed on. | Remove the server, or ask its author to simplify the tool. |
| `[zn-shield BLOCKED TOOL NAME] tools/list: <n> tool(s) removed because the tool name could not be passed on safely.` and `... because the list is over the 5000-tool limit zn-gate checks.` | Some tool names contain characters zn cannot pass on safely, or the list is far too long. | Ask the server's author to use plain names, or use a server with fewer tools. |
| `[zn-shield BLOCKED SERVER MESSAGE] <what> Rule: <rule>` | Text the server sent (a notification, a resource, an error, instructions...) carries an injection. It was replaced by a notice. | Do not trust that server. |
| `[zn-shield BLOCKED SERVER MESSAGE] ... is too large to check in full (<n> MB; the limit is 32 MB).` | One text from the server was larger than the limit and was blocked. | Ask for less data. |
| `[zn-shield BLOCKED SERVER MESSAGE] A line from the server that is not valid JSON was dropped (<n> characters). An MCP server must send one JSON message per line.` and `A line from the server was dropped: <why>.` | The server broke the protocol or sent a line that could not be checked. | The server is faulty. Update it, or report it to its author. |
| `[zn-shield BLOCKED SERVER MESSAGE] <n> more blocked text(s) in the same message were not logged one by one (<per rule counts>)` | One message held more than 50 blocked texts. The others were handled the same way but only counted. | Read the counts. This many in one message means a hostile or broken server. |
| `[zn-shield BLOCKED RESPONSE] Indirect prompt injection detected in output of tool '<tool>'. Rule: <rule>` | A tool's reply carries text that tries to instruct the agent. | Treat the source of the output with care. Do not ask the agent to bring the text back. |
| `[zn-shield BLOCKED RESPONSE] Output of tool '<tool>' is too large to check in full (<n> MB; the limit is 32 MB). Ask the tool for a smaller result.` and `... is mostly invisible characters. Rule: size:invisible` | A reply was too big to check, or it was mostly invisible characters. | Ask for a smaller part, such as a page or a line range. |
| `[zn-shield TOOL SHADOWING] <tools>: ...` (four wordings) | A tool has the same name as an approved tool of another server, a name that looks like one, a text that names a tool of another server, or a text too long to check for that. The agent may call the wrong tool. | Check that both servers are yours, and read the text of the tool. See [tool shadowing](#tool-shadowing). |
| `[zn-shield TOOLS CHANGED] <tools>: new or changed since the tools of this server were approved. Review them, then run in your own terminal: zn-gate pins approve <key>` | The server now lists tools that are new or different since you approved them. | Look at the change, then approve it in your own terminal (see [Approving a change](#approve-a-change)). |
| `[zn-shield TOOLS REFUSED] The server lists more than one tool named <name> ... These cannot be approved; the server has to fix its tool list.` | A duplicate name, or tools without a valid name. | You cannot approve these. The server's author has to fix the list. |
| `[zn-shield] Pinned the tools of a new MCP server (<key>): <label>` | A notice, not a problem: the first list of a new server is trusted and saved. | Nothing. A change later is flagged. |
| `[zn-shield] Could not read or write the MCP tool pins in <folder> (<reason>). Every tool of this list is treated as unapproved ...` | The pins folder cannot be used, so the shield cannot tell what you approved. | Fix the permissions or the disk space of that folder, then restart your agent. Approving does not help before that. |
| `[zn-shield] A line from the server was not checked (<why>); shadow mode passes it on unchecked.` and the similar lines for the client | Shadow mode only: a line could not be checked, and it was passed on anyway. | Read the reason. When you are ready to enforce, run the server without `--shadow`. |

Every blocked text also goes into your [evidence log](cli.md#evidence). When a message does not appear here, see [Troubleshooting zn-gate](troubleshooting.md).

## Limits

- Pinning covers tool definitions (names, descriptions and parameters). It does not check the server's code.
- The shadowing check only knows servers that were pinned on this machine, and it compares names, not what a tool does.
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

## Exit codes

The exit codes of `zn-gate shield`, from the table in [Exit codes](exit-codes.md#agents-and-mcp-servers):

| Code | Meaning |
| --- | --- |
| `1` | When no command is given or the program cannot be started; otherwise the shield ends when the wrapped server ends. |

More: [Protect MCP servers on usezn.com](https://usezn.com/docs/zn-gate/shield/), [what zn-gate cannot do](threat-model.md), [how the decision log works](architecture.md).
