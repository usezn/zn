# Google Antigravity

Set up zn-gate in Google Antigravity: install its hooks and add it as an MCP server, and what zn-gate does and does not cover there.

## Install (no coding needed)

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

Status: these steps follow Antigravity's documentation.

## Install the hooks

zn-gate has an adapter for Antigravity (the app, the CLI and the IDE). It adds a hook that runs before each tool call. In your own terminal, not through your agent:

```bash
npx -y zn-gate init
```

`init` looks for Antigravity (a `~/.gemini/antigravity`, `~/.gemini/antigravity-cli` or `~/.gemini/config` folder), shows each step and asks before it runs one. To do just this step with zn-gate installed (`npm install -g zn-gate`):

```bash
zn hooks install antigravity
```

This writes the hook to `~/.gemini/config/hooks.json` for your user. Add `--project` to write `.agents/hooks.json` in the current project instead; a project hook runs `zn` from your `PATH`, so everyone who opens the project in Antigravity needs zn-gate installed (without it the hook blocks the call with a message that says how to install it). The command is written for the kind of machine you ran it on (macOS and Linux, or Windows): a teammate on the other kind runs the same command in their own copy. zn-gate keeps a backup of a file it changes, and `zn hooks uninstall antigravity` removes the hook. `zn hooks install antigravity` also starts the hook once with a harmless test event and tells you if it does not answer with a valid decision. If it says `SELF-CHECK FAILED`, follow the next step it prints (usually `npm install -g zn-gate`, then install again) before you use Antigravity. Then run `npx -y zn-gate check`, which reports whether the Antigravity hook works.

## What zn-gate protects in Antigravity, and what it does not

| | In Antigravity |
| - | - |
| Blocks the agent from reading or writing `.env` and credential files by path (hooks) | Yes, once the hooks are installed |
| Blocks shell commands that carry a secret marker in their arguments, and tells the agent to run them through `zn run --secrets` (hooks) | Yes, once the hooks are installed |
| Asks you first when a search covers a folder that holds a plain-text `.env` or key file (hooks) | Yes, once the hooks are installed |
| Stops the agent from editing the hook files and Antigravity's CLI settings file | Yes, those three files (listed below) |
| Removes secrets from shell output and file contents | **No**: Antigravity hooks cannot rewrite what a tool returns |
| Blocks a secret pasted into the chat | **No** |
| Checks the arguments of MCP tool calls before they run (hooks) | Yes: a secret value or `__ZN_` marker is blocked, personal data asks you first, and file paths get the read and write checks. MCP calls are recognized by a tool name that starts with `mcp` |
| Stops the agent from editing Antigravity's MCP configuration | **No**, not yet |
| zn-gate's checks available to the agent (MCP) | Yes, if you add the MCP server (below) |
| Your other MCP servers checked for prompt injection and secrets | Yes, if you wrap them (below) |

Things to know:

- **A home folder with a space in its path needs one extra step.** Antigravity starts a hook by splitting the command on spaces, so zn-gate cannot use a launcher path with a space: `zn hooks install antigravity` stops with a message, and you run `ZN_HOOK_DIR=<a folder with no spaces> zn hooks install antigravity` instead. Choose a folder outside your home, for example `sudo mkdir -m 700 /opt/<you>-zn-hooks && sudo chown <you> /opt/<you>-zn-hooks` (or one under `$XDG_DATA_HOME` if that path has no space). On systems where `/opt` is a link (Fedora Silverblue and other rpm-ostree systems link it to `/var/opt`), use `/var/opt/<you>-zn-hooks` or `/usr/local/<you>-zn-hooks` instead; the message zn-gate prints suggests a folder that works on your machine. When it refuses a folder, it names the folder above the launcher that fails and why, and for a folder you own that others can write (and that is not a shared sticky-bit folder) it gives `chmod g-w,o-w <folder>`, with no `sudo`. The folder must be a real folder with no link anywhere in its path, and it and every folder above it must be owned by you or by root and not writable by anyone else: the launcher in it runs on every tool call, and a shared folder such as `/tmp` can be emptied or replaced by someone else while the hook keeps pointing at it, so zn-gate refuses it and says why. If you uninstall without `ZN_HOOK_DIR` set, the old launcher script stays in that folder (nothing refers to it any more) and you can delete it.
- **What we tested.** Antigravity does not document what happens when a hook crashes or times out. The hook is built from Antigravity's public documentation and checked by hand on a real Windows machine (Antigravity IDE and CLI, October 2026). There is no automated end-to-end run yet, so Antigravity can change this behavior in a new version without us noticing; `zn-gate check` shows whether the hook works on your machine.
- **If the zn hook cannot run, Antigravity blocks the tool call.** In our tests, a hook that failed to start, printed nothing, printed text that is not JSON, or printed `{}` made Antigravity deny every tool call, with an empty reason. That is the safe direction, but it stops the agent until the hook is repaired (`npx -y zn-gate check` shows how). zn-gate itself always answers with an explicit allow or deny, and if it fails inside, it denies with a plain reason. If the Node.js zn-gate was installed with goes missing, zn-gate's launcher script blocks the call with a message that tells you to reinstall zn-gate and run `zn hooks install antigravity` again. **Not tested:** a hook that runs past its time limit, and whether an organization can turn hooks off. We do not know what Antigravity does in those cases, so do not rely on a blocked call there.
- **Other hooks.** A hook can be turned off with `"enabled": false` (zn-gate check reports zn's own as not protected when it is). Antigravity does not document in which order hooks run or which answer wins, and a CLI plugin can carry hooks of its own, so another hook that runs for the same tool call may change what zn's deny means. `zn-gate check` lists the other enabled `PreToolUse` hooks it finds in your hooks file and the project's, and cannot see plugin hooks. In our tests Antigravity did not always run other plugins' hooks alongside zn's; zn's hooks always ran and its deny always applied.
- **Search runs through the shell.** In our tests the agent's file search ran as a shell command (`run_command`), including over files that `.gitignore` excludes, such as a `.env`. zn-gate therefore checks it as a command, not as a file read, so a search is covered only as far as the command checks go.
- **Values can still reach the model.** A value printed by a command, or found in a file the agent is allowed to read, is not removed. Keep secrets in the vault.
- **A tool that names no command and no file path**, or that zn-gate does not recognise, is left to Antigravity's own rules. A shell or file tool whose command or file zn-gate cannot read is refused.
- **Which files the agent cannot edit:** `.agents/hooks.json` in a project, `~/.gemini/config/hooks.json` and `~/.gemini/antigravity-cli/settings.json`.
- **Which files are not protected:** Antigravity's MCP configuration (`.agents/mcp_config.json`, `~/.gemini/antigravity/mcp_config.json` and `~/.gemini/config/mcp_config.json`) and the other files in a project's `.agents` folder (rules and workflows). An agent that can write files could change them.

More detail is in the [threat model](../threat-model.md).

### The MCP server on its own

The MCP server (Install above) is not automatic protection: the agent decides when to call `analyze_prompt`, `check_tool_call` and `check_tool_result`.

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

## Verify

Run `npx -y zn-gate check` in your own terminal. It makes a temporary folder with a fake `.env` file and an ordinary file, asks zn's hook to let the agent read each one, and reports whether the Antigravity hook blocked the `.env` file and allowed the other. Nothing is sent over the network and no setting changes. See [Check that it works](../check.md).

This checks the hooks. To check the MCP server too, restart Antigravity and ask the agent to call `zn_status`.

## Uninstall

In your own terminal:

```bash
zn hooks uninstall antigravity
```

If you installed the hooks for one project only, add `--project` and run it from that project's folder. A backup of the settings file is written first. To remove the MCP server, delete the `zn-gate` entry from the MCP settings file you edited in Install. If you ran `npx -y zn-gate init --wrap-mcp`, `npx -y zn-gate init --revert` puts back each MCP settings file as it was saved before wrapping. See [Remove zn-gate](../uninstall.md).

## Troubleshooting

- **`node: command not found`, or Node.js is too old** (zn-gate needs 18 or later): see [Node.js is too old](../troubleshooting.md#1-nodejs-is-too-old) and [`npx: command not found`](../troubleshooting.md#2-npx-command-not-found).
- **"running scripts is disabled on this system" on Windows:** see [the PowerShell message](../troubleshooting.md#3-running-scripts-is-disabled-on-this-system-windows).
- **The zn-gate tools do not appear in Antigravity:** check that the settings file is valid and that the `zn-gate` entry sits inside the existing server section, then restart Antigravity.
- **A command says it needs you at your own terminal:** see [It needs you at your own terminal](../troubleshooting.md#4-it-needs-you-at-your-own-terminal).

All messages: [Troubleshooting](../troubleshooting.md).

## Antigravity documentation

- MCP in Antigravity: <https://antigravity.google/docs/mcp>
- Hooks in Antigravity: <https://antigravity.google/docs/hooks>
