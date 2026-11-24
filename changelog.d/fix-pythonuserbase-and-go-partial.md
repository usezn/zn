### Security
- `zn run` and the hook launchers also drop `PYTHONUSERBASE`, which can point Python at a user site directory whose start-up files run before the approved program.

### Fixed
- The Go client's `Allowed()` is now false when only part of a long input was checked, so a partial allow no longer passes as a full check.
