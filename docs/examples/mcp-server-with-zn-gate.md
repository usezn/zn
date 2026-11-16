# Example: the two MCP servers of zn-gate

zn-gate can run as an MCP server in two different ways. They have different jobs, so this page puts them side by side: what each one is, how an agent gets it, and what the agent sees. Both are in the npm package only; the Python package prints a note and exits `2` (see the [command reference](../cli.md#mcp-servers)). Both talk over standard input and output, and both exit when their input is closed.

| | `zn-gate mcp` | `zn-gate secrets-mcp` |
|---|---|---|
| What it is | A checker the agent can call on text and on tool calls | A way for the agent to use a secret without ever seeing it |
| Server name used here | `zn-gate` | `secrets` |
| Who sets it up | You, by hand | `zn hooks install <agent>` (or by hand) |
| Needs the vault | No | Yes: it uses the secrets in your [vault](../secrets.md) |
| Sends anything away | No (see below for the optional cloud check) | Only the HTTP request the agent asked for, to a host you allowed |

You do not run either command in a terminal yourself. The agent starts them from its MCP settings.

## `zn-gate mcp`: a checker the agent can call

This server is not automatic protection: the agent calls it when it decides to. For protection that runs on every action, use [hooks](../cli.md#hooks).

Add it to your agent. These are the lines from the package README:

```bash
claude mcp add zn-gate -- npx -y zn-gate mcp     # Claude Code
codex mcp add zn-gate -- npx -y zn-gate mcp      # Codex CLI
```

For Cursor (`~/.cursor/mcp.json`) and other editors that use the `mcpServers` form:

```json
{ "mcpServers": { "zn-gate": { "command": "npx", "args": ["-y", "zn-gate", "mcp"] } } }
```

For OpenCode (`~/.config/opencode/opencode.json`):

```json
{ "mcp": { "zn-gate": { "type": "local", "command": ["npx", "-y", "zn-gate", "mcp"], "enabled": true } } }
```

What the agent sees is a list of four tools:

| Tool | What the agent can ask |
|---|---|
| `analyze_prompt` | Is this text a prompt injection, a jailbreak, a role hijack or an attempt to steal credentials? Returns a verdict (allow or block), a confidence score and the rule that matched. |
| `check_tool_call` | Is this tool call safe to run? Takes the tool name and its arguments. Returns `safe_to_execute`, the verdict and the arguments with sensitive values hidden. |
| `check_tool_result` | Does this output, from a web page, a file or an API, hide instructions or secrets? Returns the content with secrets redacted, or neutralized if an injection is found. |
| `zn_status` | What is zn-gate doing, and does anything leave this computer? Takes no arguments. |

The checks run on your computer. Only if you turned on the optional [cloud check](first-cloud-check.md) is the text, with secrets removed, also sent to the zn cloud. `zn_status` tells the agent which of the two is active.

In Claude Code, an entry added with `npx` is treated like any other MCP server, so a call that carries personal data is asked about first. See [compat](../compat.md) for the exact rules.

## `zn-gate secrets-mcp`: use a secret without seeing it

This server is the other half of the [secrets vault](../secrets.md). Your agent never gets the value of a key. It writes a marker such as `__ZN_GITHUB_TOKEN__` where the value would go, and zn puts the real value in when it makes the request.

For Claude Code, `zn hooks install claude-code` registers it for your user with `claude mcp add-json`. If the `claude` command is not found, the install prints the `claude mcp add --scope user secrets -- ...` line to run yourself. For Codex, Cursor and OpenCode, the install prints the entry to add to the agent's own MCP file, and says it is optional. A project install (`--project`) adds no server for Claude Code. Use `--no-mcp` to leave the server out. Copy the printed entry rather than writing it from memory: it names the Node.js and the zn-gate files on your machine. The entry ends with `secrets-mcp --agent <id>`, where `--agent` tells zn which agent started the server (it is a label, not a security control).

What the agent sees is four tools:

| Tool | What the agent can ask |
|---|---|
| `secrets_list` | Which secrets are stored: name, marker, mode, allowed hosts and allowed commands. Never the values. |
| `secrets_http_request` | Make an HTTP request with a marker in a header. zn sends it with the real value only if the host is in that secret's allowed hosts, and returns the response with secrets replaced by markers. |
| `secrets_render_file` | Fill a template file that holds markers into an output file, for tools that need a config file. Only for secrets stored in `file` mode, and the output must be git-ignored or outside a git repository. Returns the path, never the content. |
| `secrets_request` | Ask you to add a secret the agent needs. You add the value in your own terminal; the agent never receives it. |

There is no tool that returns a value. An example call of `secrets_http_request`, with a made-up marker:

```json
{ "method": "GET", "url": "https://api.example.com/user",
  "headers": { "Authorization": "Bearer __ZN_EXAMPLE_TOKEN__" } }
```

If the secret is not stored, the tool answers with an error that tells the agent to use `secrets_request`. If the host is not allowed, nothing is sent. How to store a secret and allow a host is in [secrets](../secrets.md#5-let-the-agent-call-an-api).

## Remove them

- A `zn-gate` entry you added by hand is not touched by any command: delete that entry yourself ([remove page](../uninstall.md)).
- `zn hooks uninstall claude-code` removes zn's own `secrets` server for Claude Code, unless you add `--no-mcp`.

## More

- [`mcp` and `secrets-mcp` in the command reference](../cli.md#secrets-mcp)
- [Secrets: let the agent call an API](../secrets.md#5-let-the-agent-call-an-api)
- [`hooks` in the command reference](../cli.md#hooks)
