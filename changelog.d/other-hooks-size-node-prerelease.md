### Fixed
- `zn-gate check` no longer skips a Codex `hooks.json` or `config.toml` larger than 256 KB: it reports the file as too large to check, so a huge file cannot hide another tool's hook.
- The Node.js version warning now treats a prerelease of the first patched version (for example 22.23.4-rc.1) as older than that release.
