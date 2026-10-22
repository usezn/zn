### Changed
- `zn audit` checks the supporting files of a skill (templates and references) for long blank runs (ZNA021) the same way as the main file, because a skill can load them into the agent's context. The audit documentation says so. `AUDIT_RULES_VERSION` is unchanged.
