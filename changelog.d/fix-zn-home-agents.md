### Fixed
- With `ZN_HOME` set, agent file writes (patches in Codex and ZCode, and writes in the other agents) into that folder are refused like writes into `~/.zn`. Before, only the default `~/.zn` folder was protected.
- A short `ZN_HOME` such as `/zn` is protected too. Only a `ZN_HOME` that is a home folder or the root of a file system is not taken, because it would protect everything below it.
