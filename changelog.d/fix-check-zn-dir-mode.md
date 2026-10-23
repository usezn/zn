### Changed

- `zn-gate check` warns when `~/.zn` is not mode 0700 (Linux and macOS). The hooks then skip the Node.js compile cache and start a few milliseconds slower. The fix is `chmod 700 ~/.zn`.
