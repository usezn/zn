### Security

- The Claude Code plugin and `zn hooks install claude-code` now block a tool call, instead of running it unchecked, when the zn hook cannot start or times out (for example when `node` is missing from the `PATH`). Prompts were already blocked this way. Update the plugin with `claude plugin update zn-gate@usezn` and start a new session; if you use `zn hooks install claude-code`, run it again. It needs Claude Code 2.1.295 or later; earlier versions ignore the setting.
