### Fixed
- zn audit now reports a symbolic link to an agent directory that leaves the repository (for example .claude/agents or .claude/commands pointing outside) as ZNA020, as it already did for files and for .claude and .claude/skills. Links that stay inside the repository are still followed.
