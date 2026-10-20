### Changed
- Hooks start faster. On Node.js 22.1 and later a hook keeps its compiled code in a cache under `~/.zn/cache/compile` (or under `ZN_HOME`). The folder is created for your user only (mode 0700) and is skipped if it belongs to someone else, is a link or is open to other users; set `ZN_NO_COMPILE_CACHE=1` to turn it off. Decisions and output do not change.
