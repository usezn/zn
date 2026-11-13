### Fixed
- `zn team` messages (join, sync, status, leave, an unknown subcommand, `zn team status --rules`) now name the command
  the way your machine runs it: `zn.cmd` on Windows, and `npx -y zn-gate@<version>` when `zn` is not on your PATH,
  like the other zn messages. Before, they always said `zn team ...`, which fails in PowerShell with the default
  execution policy.
