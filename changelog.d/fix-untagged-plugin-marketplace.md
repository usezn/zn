### Fixed

- `zn-gate init`, `zn-gate check` and the plugin messages add the Claude Code plugin marketplace without a release tag again (`claude plugin marketplace add usezn/zn`), so the plugin you install pins the latest published zn-gate and matches the installed release. A tag holds the plugin pin of the previous release, which left the plugin one release behind.
