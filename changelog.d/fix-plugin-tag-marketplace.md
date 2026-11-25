### Fixed

- `zn-gate init`, `zn-gate check`, the plugin messages and the docs now add the plugin marketplace at a plugin tag: `claude plugin marketplace add usezn/zn#plugin-v<version>` for Claude Code and `codex plugin marketplace add usezn/zn --ref plugin-v<version>` for Codex. The tag is created on the commit that pins that zn-gate release and never moves, so the plugin you install pins the release you expect. The release tag (`usezn/zn#v<version>`) held the plugin pin of the previous release, which left the plugin one release behind.
