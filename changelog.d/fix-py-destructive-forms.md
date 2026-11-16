### Security
- Python package: the destructive-command check now blocks more spellings of the commands it already blocks. They are
  ANSI-C quoted `chmod`, `dd` and device paths, default-value expansions such as `${NAME:-/home/alice}`, brace lists
  such as `{rm,-rf,/home/alice}` and `rm -rf /{,}`, and PowerShell `Remove-Item` with a variable, `-Recurse:$true`,
  `-Path:C:\`, a quoted path, a backtick in the name, a script block or `iex`. It also blocks cmd.exe `rd /s/q C:\`
  with `@`, `call`, `start`, `%ComSpec%`, `%SystemDrive%`, `\\?\C:\` or a `set` variable, and a download written into
  a startup file through a glued redirect, a group or an `exec` file descriptor. Finally, it blocks a download run
  from a group, `eval` or `env -S`, an interpreter fed by `<(curl URL)` or `-c "$(curl URL)"`, and PowerShell
  `| & iex` forms.
