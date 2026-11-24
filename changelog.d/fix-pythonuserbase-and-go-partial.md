### Security
- `zn run` and the hook launchers on Linux and macOS also drop `PYTHONUSERBASE`, which can point Python at a user site directory whose start-up files run before the approved program.

### Fixed
- The Go client's `Allowed()` is now false when only part of a long input was checked (a partial, capped or truncated result), so such an allow no longer passes as a full check. `WholeInputChecked()` reports it directly.
