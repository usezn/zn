### Fixed

- `zn team status` shows a warning (also in `--json` as `revocations_dropped`) when a pending revocation was dropped to make room before this version: the server was never told, so an admin can remove that installation from the dashboard. The warning is shown for 30 days and no new drop happens, because pending revocations are now all kept (see the next entry).
