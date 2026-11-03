### Security
- The Claude Code plugin repository builder now refuses bundled code that uses `eval`, the `Function` constructor or a `require()` with a name that is not a plain quoted string, so the import check cannot be bypassed that way.
