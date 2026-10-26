### Security
- The agents' plugin folders and plugin state are protected at their real place when the agent's configuration folder or its plugin folder is a link to another folder (for example a `~/.claude`, `~/.codex`, `~/.cursor`, `~/.zcode` or `~/.gemini` kept in a dotfiles folder, or a linked `plugins` folder, also under `CLAUDE_CONFIG_DIR` and `CODEX_HOME`). Before, a write or delete through the real path of such a link was allowed.
- The ZCode page no longer says that the files of the ZCode plugin are unprotected: they are protected under `~/.zcode/cli/plugins/`.
