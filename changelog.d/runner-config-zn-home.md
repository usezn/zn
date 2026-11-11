### Fixed
- Hook settings in `config.json` (such as `agentInstructionWrites` or `egressCheck`) are read from `ZN_HOME` when it is set, like the rest of zn. With `ZN_HOME` unset nothing changes.
