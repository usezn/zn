### Added
- The plugin build can produce an Antigravity CLI plugin (`build-plugin-repo.js --target antigravity`): the same `PreToolUse` hook as `zn hooks install antigravity`, with its own pinned and verified copy of zn-gate, that answers `deny` with the reason when zn cannot answer. Its install steps are published with the plugin repository.

### Changed
- The plugin launcher knows the Antigravity answer format: it always prints an explicit decision, and turns an answer that is not one, or a zn-gate failure, into a `deny`.
