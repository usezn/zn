# Continue: set up zn-gate and verify it

This example walks through the zn-gate setup in Continue, with made-up values.
Continue has no hook API that zn-gate can use, so in Continue zn-gate works as an
**MCP server only**: the agent can call its tools to check a prompt, a tool call
or a tool result, but the agent decides when to call them. Read
[Continue](../editors/continue.md) for what this does and does not cover.

## 1. Add zn-gate to the MCP servers

Open your Continue configuration file (`config.yaml`) and add the `zn-gate` entry
to the `mcpServers` list:

```yaml
mcpServers:
  - name: zn-gate
    type: stdio
    command: npx
    args: ["-y", "zn-gate", "mcp"]
```

If the file already has an `mcpServers:` list, add only the `- name: zn-gate`
entry to it.

## 2. Wrap another MCP server (optional)

Each local MCP server you use in Continue can be started through zn-gate. The
wrapper checks every result of that server for prompt injection and removes the
secrets zn-gate recognizes before the agent sees them. In this example the
server is a made-up notes server started with `uvx example-notes-mcp`:

```yaml
mcpServers:
  - name: zn-gate
    type: stdio
    command: npx
    args: ["-y", "zn-gate", "mcp"]
  - name: notes
    type: stdio
    command: npx
    args: ["-y", "zn-gate", "shield", "--", "uvx", "example-notes-mcp"]
```

The only change to the `notes` entry is the wrapper: `npx -y zn-gate shield --`
goes in front of the original command and its arguments. If you put the original
command back, the server is no longer checked.

## 3. Restart Continue and check the tools

Restart Continue. zn-gate's tools are available in Continue's **Agent** mode.
In Agent mode, ask the agent to call `zn_status`. The answer is a short JSON
object such as this one (output of zn-gate 1.15.0 on a test machine with no API key):

```json
{
  "package": "zn-gate@1.15.0",
  "engine": "local-rules",
  "endpoint": "none (local only)",
  "rules_version": "2026-11-04.35",
  "cloud_enabled": false,
  "leaves_machine": "nothing",
  "lifecycle_coverage": "bidirectional (prompt, pre-tool-call, post-tool-result)"
}
```

The version and rules version change with each release. The tool list should show
`analyze_prompt`, `check_tool_call`, `check_tool_result` and `zn_status`.

## 4. Check the command line

Run this in your own terminal:

```bash
npx -y zn-gate status
```

It prints the package version, the rules version, the engine (`Local rules only`
when no API key is set) and `Leaves machine: Nothing`.

`npx -y zn-gate check` does not test a Continue setup. It tests the agents that
have zn-gate hooks, and Continue is not one of them. With no supported agent on
the machine it prints this, which is expected here:

```text
No supported coding agent was found on this machine (Claude Code, Codex CLI, Cursor, OpenCode, Antigravity, ZCode desktop app), so there is nothing to check.
```

Use the agent step in section 3 to see the zn-gate tools in Continue.

## 5. Remove it

Delete the `zn-gate` entry, and any `zn-gate shield` wrapper you added (put back
the original command), then save the file and restart Continue. The steps are in
[Continue: Uninstall](../editors/continue.md#uninstall). Removing the program is
described in [Remove zn-gate](../uninstall.md).

## Related

- [Continue](../editors/continue.md): the full setup page for Continue.
- [Check that it works](../check.md): what `zn-gate check` tests for each agent.
