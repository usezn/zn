# Google Antigravity

Set up zn-gate in Google Antigravity: install its hooks (experimental) and add it as an MCP server, and what zn-gate does and does not cover there.

## Quick start (no coding needed)

1. **Check that Node.js is installed.** Open a terminal (in most editors: menu **Terminal → New Terminal**; or your computer's Terminal app), type `node --version` and press Enter. If you see a version number (18 or later), go on. If you see "command not found", install the **LTS** version from [nodejs.org](https://nodejs.org/) and restart Antigravity.
2. At the top of the agent panel, open the **…** menu → **MCP Servers** → **Manage MCP Servers** → **View raw config**. (This is the file `~/.gemini/antigravity/mcp_config.json`, or `~/.gemini/config/mcp_config.json` in some versions, where `~` is your user folder, for example `C:\Users\you` on Windows.)
3. Paste this:

   ```json
   {
     "mcpServers": {
       "zn-gate": {
         "command": "npx",
         "args": [
           "-y",
           "zn-gate",
           "mcp"
         ]
       }
     }
   }
   ```

   If the file already has a `"mcpServers"` section, add only the `"zn-gate": {...}` part inside it.
4. Save the file and restart Antigravity.

Status: these steps follow Antigravity's documentation; not yet verified by us in Antigravity.

## Install the hooks (experimental)

zn-gate has an experimental adapter for Antigravity (the app, the CLI and the IDE). It adds a hook that runs before each tool call. In your own terminal, not through your agent:

```bash
npx -y zn-gate init
```

`init` looks for Antigravity (a `~/.gemini/antigravity`, `~/.gemini/antigravity-cli` or `~/.gemini/config` folder), shows each step and asks before it runs one. To do just this step with zn-gate installed (`npm install -g zn-gate`):

```bash
zn hooks install antigravity
```

This writes the hook to `~/.gemini/config/hooks.json` for your user. Add `--project` to write `.agents/hooks.json` in the current project instead; a project hook runs `zn` from your `PATH`, so everyone who opens the project in Antigravity needs zn-gate installed. zn-gate keeps a backup of a file it changes, and `zn hooks uninstall antigravity` removes the hook. Then run `npx -y zn-gate check`, which reports whether the Antigravity hook works.

## What zn-gate protects in Antigravity, and what it does not

| | In Antigravity |
| - | - |
| Blocks the agent from reading or writing `.env` and credential files by path (hooks) | Yes, once the hooks are installed |
| Blocks shell commands that handle secrets, and tells the agent to run them through `zn run` (hooks) | Yes, once the hooks are installed |
| Asks you first when a search covers a folder that holds a plain-text `.env` or key file (hooks) | Yes, once the hooks are installed |
| Stops the agent from editing the hook files and Antigravity's CLI settings file | Yes, those three files (listed below) |
| Removes secrets from shell output and file contents | **No**: Antigravity hooks cannot rewrite what a tool returns |
| Blocks a secret pasted into the chat | **No** |
| Stops the agent from editing Antigravity's MCP configuration | **No**, not yet |
| zn-gate's checks available to the agent (MCP) | Yes, if you add the MCP server (below) |
| Your other MCP servers checked for prompt injection and secrets | Yes, if you wrap them (below) |

Things to know:

- **It is experimental.** It is built from Antigravity's public documentation. Antigravity does not document what happens when a hook crashes or times out, so zn-gate cannot promise that such a call is blocked.
- **Values can still reach the model.** A value printed by a command, or found in a file the agent is allowed to read, is not removed. Keep secrets in the vault.
- **A tool zn-gate cannot classify** (or whose arguments it cannot read as a command or a file path) is left to Antigravity's own rules.
- **Which files the agent cannot edit:** `.agents/hooks.json` in a project, `~/.gemini/config/hooks.json` and `~/.gemini/antigravity-cli/settings.json`.
- **Which files are not protected:** Antigravity's MCP configuration (`.agents/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json` and `~/.gemini/config/mcp_config.json`) and the other files in a project's `.agents` folder (rules and workflows). An agent that can write files could change them.

More detail is in the [threat model](../threat-model.md).

### The MCP server on its own

The MCP server (quick start above) is not automatic protection: the agent decides when to call `analyze_prompt`, `check_tool_call` and `check_tool_result`.

## Technical reference

### Where the configuration lives

All projects: `~/.gemini/antigravity/mcp_config.json` (or `~/.gemini/config/mcp_config.json` in some versions). One project: `.agents/mcp_config.json`. `npx -y zn-gate init --wrap-mcp` wraps the servers in the all-projects file for you, or wrap them by hand as below.

### Check the output of your other MCP servers

To check the output of the other MCP servers you use in Antigravity, start each local server through zn-gate: replace its command with `npx` and put `-y zn-gate shield --` in front of its original command and arguments. For example, a server started with `uvx mcp-server-fetch` becomes:

```json
{
  "mcpServers": {
    "fetch": {
      "command": "npx",
      "args": [
        "-y",
        "zn-gate",
        "shield",
        "--",
        "uvx",
        "mcp-server-fetch"
      ]
    }
  }
}
```

Every result of that server is then checked for prompt injection, and secrets zn-gate recognizes are removed, before the agent sees it. `zn-gate init --wrap-mcp` does this automatically for Claude Desktop, Claude Code, Cursor, Codex, OpenCode and Antigravity.

## Antigravity documentation

- MCP in Antigravity: <https://antigravity.google/docs/mcp>
- Hooks in Antigravity: <https://antigravity.google/docs/hooks>
