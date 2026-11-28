### Security
- The destructive-command rule for the filesystem root, the home folder and system folders now reads a path that ends in a carriage return
  (as a Windows command line can) as the same folder, in the Node.js library, the Python library and the agent hooks. Before, a recursive
  delete of a drive root or a system folder followed by a carriage return was not recognised and was allowed. Medium, CVSS 3.1 6.3
  (`AV:L/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:H`); present since 1.14.0 by the history of the rule, fixed in the next release.

### Fixed
- The hook's review of writes to agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules` and the others) now also
  asks when the target is written as a brace list or a glob that reaches one of them, such as `{AGENTS,x}.md` or `AGENT?.md`.
