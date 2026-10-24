### Security
- `zn-gate check` now accepts a project hook as zn's guard only when it is exactly the command zn writes; a guard-looking command that differs is reported as modified, with the command that rewrites it (`zn hooks install <agent> --project`).
