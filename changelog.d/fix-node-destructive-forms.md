### Security
- Node.js package: the destructive-command check (`checkCommand()` and the opt-in agent hook rule) now blocks the same
  extra spellings as the Python package. They are ANSI-C quoted `chmod`, `dd` and device paths, default-value
  expansions such as `${NAME:-/home/alice}`, brace lists such as `{rm,-rf,/home/alice}` and `rm -rf /{,}`, PowerShell
  `Remove-Item` with a variable, `-Recurse:$true`, `-Path:C:\`, a quoted path, a backtick, a script block or `iex`,
  and cmd.exe `rd /s/q C:\` with `@`, `call`, `start`, `%ComSpec%`, `%SystemDrive%`, `\\?\C:\` or a `set` variable.
  It also blocks a download written into a startup file through a glued redirect, a group or an `exec` file
  descriptor, a download run from a group, `eval` or `env -S`, an interpreter fed by `<(curl URL)` or
  `-c "$(curl URL)"`, and PowerShell `| & iex` forms. Both packages read these cases from one shared test list.
- Both packages: long lines with many `(` after `iex`, many `>` or many joined `/s` options are now checked in linear
  time instead of taking seconds.
