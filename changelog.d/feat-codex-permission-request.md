### Added
- Codex CLI: zn-gate answers Codex's `PermissionRequest` hook with a deny when its check would deny the call (a secret in a command, a credential file, a placeholder sent to another MCP server). zn never answers Allow there, so no Approve button is shown for a call zn blocks. Run `zn hooks install codex` again, then review the hook in `/hooks`.
