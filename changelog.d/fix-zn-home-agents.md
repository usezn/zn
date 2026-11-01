### Fixed
- With `ZN_HOME` set, agent file writes (patches in Codex and ZCode, and writes in the other agents) into that folder are refused like writes into `~/.zn`. Before, only the default `~/.zn` folder was protected.
