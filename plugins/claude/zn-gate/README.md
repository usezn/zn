# zn-gate plugin for Claude Code

## Requirements

- **Claude Code 2.1.295 or later** (`claude --version`). On earlier versions, a prompt hook that cannot run does not block the prompt.
- **Node.js 18 or later (the LTS release), with npm, on your PATH** (`node --version`). The native Claude Code installer does not include Node.js. Without it, Claude Code reports at session start that `node` was not found and blocks every prompt, so nothing is sent unprotected; install Node.js from https://nodejs.org and start a new session.
- **Git** (on Windows, Git for Windows), to add the marketplace from GitHub: without it, `claude plugin marketplace add` fails with "git not found". The hooks themselves start `node` directly, without a shell.

zn-gate keeps secret values out of what Claude Code sends to the model. Real values stay in an encrypted vault on your machine, and Claude works with markers such as `__ZN_STRIPE_KEY__`. The plugin also adds a local prompt-injection check that Claude can run on untrusted text before acting on it.

## Where it protects you

- **Claude Code** in the terminal, the IDE extensions and local sessions in the Code tab of the Claude desktop app: hooks and both MCP servers. The Code tab uses the plugins installed with `claude plugin install`. Claude Code sessions that run in the cloud (Claude Code on the web, cloud sessions in the Code tab) do not load plugins installed on your machine, so they are not protected.
- **Cowork**: zn has not verified the plugin in Cowork. Cowork takes its plugins from Customize > Plugins in Claude, not from `claude plugin install`. In a test where a Cowork task ran in the cloud workspace, a prompt containing a secret was not blocked and reached the model. **Do not rely on the plugin in Cowork.**
- **Chat** (claude.ai, the chat in the desktop app, mobile apps): this plugin is not loaded there and hooks do not run there, so **the plugin does not protect chat conversations**. Do not paste secrets into chat.

## Install

```bash
claude plugin marketplace add usezn/zn
claude plugin install zn-gate@usezn
```

If you set up hooks with the zn CLI before (`zn hooks install`), remove them first (`zn hooks uninstall claude-code`), otherwise both sets run.

Then create or unlock the vault and move the values of a `.env` file into it:

```bash
npx zn-gate@1.5.1 unlock
npx zn-gate@1.5.1 env shadow .env
```

> **Windows PowerShell:** `npm` and `npx` can fail with "running scripts is disabled on this system", because the default execution policy blocks `npm.ps1`. Use `npm.cmd` and `npx.cmd` instead (for example `npm.cmd install -g zn-gate`), run the commands from Command Prompt, or allow local scripts for your account with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## What runs, what is sent, what is downloaded

Everything in this plugin runs on your machine.

- **Downloaded once, at install:** Claude Code runs your `npm` to install the npm package `zn-gate`, pinned to version 1.5.1 by the lockfile in this folder, from the npm registry, with install scripts disabled. The plugin downloads nothing after that. (The `npx zn-gate@1.5.1` commands above are run by you, once, to set up the vault; npm downloads the same pinned version for them.) If npm is missing, the install is skipped and `claude plugin list` shows a note on the plugin, and the session start check shows how to fix it: install Node.js and run `claude plugin update zn-gate@usezn`.
- **Session start check:** `node` runs `hooks/check-node.js`, which checks the Node.js version and that the zn-gate package is in the plugin folder, and shows a warning with the fix if either is missing. It prints nothing otherwise.
- **Hooks (run on every matching event):** `node` runs the zn-gate hook on `PreToolUse` (shell, file and web tools), `PostToolUse` (shell, file, web and MCP tool output) and `UserPromptSubmit`. The hook reads the event on stdin, replaces secret values with markers or blocks the call, and writes its decision to stdout. The hooks make no network requests. If a tool hook cannot start or times out (15 seconds), the call runs unchecked and its output reaches Claude unscrubbed; other hook errors deny the call. If the prompt hook cannot run or times out (30 seconds), the prompt is blocked.
- **MCP server `zn-gate`:** the tools `analyze_prompt`, `check_tool_call`, `check_tool_result` and `zn_status`, which check text and tool calls for prompt injection with local rules. The plugin starts it with `ZN_LOCAL_ONLY=true`, so text is never sent to the zn cloud API, even if `ZN_CLOUD` and `ZN_API_KEY` are set.
- **MCP server `secrets`:** the tools `secrets_list`, `secrets_request`, `secrets_render_file` and `secrets_http_request`. They let Claude use a secret without seeing it. `secrets_http_request` makes the HTTP request that Claude asks for, to the host Claude names, with the secret filled in, only if that host is in the secret's allowed hosts (`allowHosts`); otherwise no request is made. This is the only network traffic the plugin creates, and only when Claude calls that tool.
- **Files written:** the vault and its audit log under your home directory. Nothing is written to your project unless you run a command such as `zn env shadow`.

No telemetry. No account is needed.

## Limits

In Claude Code the hooks cover shell commands, file reads and writes, web fetches, MCP tool output and prompts. Values the hooks never see (for example, a secret typed into another program's window) are out of scope. See the threat model: https://github.com/usezn/zn/blob/main/docs/threat-model.md

## License

MIT. See `LICENSE`.
