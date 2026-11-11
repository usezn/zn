### Fixed
- `zn vault log` shows a readable tool (`zn-run`) and a short reason code, such as `command_not_allowed` or `not_in_vault`, for commands that `zn run` refused, instead of `[invalid]`. Records written before this fix keep showing `[invalid]`.
