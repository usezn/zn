### Security
- A `find` that starts at the filesystem root and deletes (`-delete`, or `rm` run through `-exec`, `-execdir`, `-ok` or `-okdir`) is now refused even when it has a filter such as `-name` or `-type`. A filter does not make a delete from the root safe.
- `-execdir`, `-ok` and `-okdir` with `rm` now count as a delete, like `-exec rm`, and the GNU options `-P`, `-L`, `-H`, `-O` and `-D` before the starting paths no longer hide them (`find -P / -delete` is refused).
- A `find` that reads its starting paths from `-files0-from` (a file or stdin) and deletes is now refused, also inside your project: the paths are not in the command, so zn cannot check them. `-files0-from` without a delete stays allowed.
- Otherwise, `find` inside your project, and `find` from the root without a delete, stay allowed.
