### Changed
- GitHub Copilot is no longer marked experimental: `zn hooks install copilot` sets up the hooks that VS Code, the GitHub Copilot app and Copilot CLI share, and `zn-gate check` lists the agent as "GitHub Copilot (VS Code, CLI)". For VS Code this is documented, not tested in the app: the hooks were run end to end with Copilot CLI only. The VS Code page and the compatibility guide now quote the official documentation for each claim and state the two limits Copilot's hook format has: a typed prompt cannot be blocked, and a hook that times out lets the call through (zn answers a deny 4 seconds before that).

### Added
- `zn-gate check` warns when the project's `.claude/settings.json` also holds zn's Claude Code hooks, because Copilot reads that file too and every call would be checked twice, and names the command that keeps one of them.
