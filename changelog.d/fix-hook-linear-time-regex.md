### Fixed
- Checking a shell command with many `$(` or backtick substitutions followed by long runs of spaces, or with thousands of `curl` invocations, now takes time linear in the command size instead of quadratic, so the check no longer runs out of time on large commands. The decisions are unchanged.
