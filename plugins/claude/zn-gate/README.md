# zn-gate plugin for Claude Code

zn-gate keeps secret values out of what Claude Code sends to the model. Real values stay in an encrypted vault on your machine, and Claude works with markers such as `__ZN_STRIPE_KEY__`. The plugin also adds a local prompt-injection check that Claude can run on untrusted text before acting on it.

## Install

```bash
claude plugin marketplace add usezn/zn
claude plugin install zn-gate@usezn
```

Then create or unlock the vault and move the values of a `.env` file into it:

```bash
npx zn-gate@1.5.0 unlock
npx zn-gate@1.5.0 env shadow .env
```

Requires Node.js 18 or later on your PATH.

## What runs, what is sent, what is downloaded

Everything in this plugin runs on your machine.

- **Downloaded once, at install:** Claude Code installs the npm package `zn-gate`, pinned to version 1.5.0 by the lockfile in this folder, from the npm registry. Nothing is downloaded after that.
- **Hooks (run on every matching event):** `node` runs the zn-gate hook on `PreToolUse` (shell, file and web tools), `PostToolUse` (shell, file, web and MCP tool output) and `UserPromptSubmit`. The hook reads the event on stdin, replaces secret values with markers or blocks the call, and writes its decision to stdout. The hooks make no network requests. If a hook fails or times out (15 seconds), the call goes through unchanged.
- **MCP server `zn-gate`:** the tools `analyze_prompt`, `check_tool_call`, `check_tool_result` and `zn_status`, which check text and tool calls for prompt injection with local rules. The plugin starts it with `ZN_LOCAL_ONLY=true`, so text is never sent to the zn cloud API, even if `ZN_CLOUD` and `ZN_API_KEY` are set.
- **MCP server `secrets`:** the tools `secrets_list`, `secrets_request`, `secrets_render_file` and `secrets_http_request`. They let Claude use a secret without seeing it. `secrets_http_request` makes the HTTP request that Claude asks for, to the host Claude names, with the secret filled in; this is the only network traffic the plugin creates, and only when Claude calls that tool.
- **Files written:** the vault and its audit log under your home directory. Nothing is written to your project unless you run a command such as `zn env shadow`.

No telemetry. No account is needed.

## Limits

In Claude Code the hooks cover shell commands, file reads and writes, web fetches, MCP tool output and prompts. Values the hooks never see (for example, a secret typed into another program's window) are out of scope. See the threat model: https://github.com/usezn/zn/blob/main/docs/threat-model.md

## License

MIT. See `LICENSE`.
