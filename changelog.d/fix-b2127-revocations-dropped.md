### Fixed

- `zn team leave` no longer drops an old pending revocation without saying so. When more than 8 installations have left while the server was unreachable, the oldest one is still dropped to keep the list small, but zn now writes an audit record for it and `zn team status` shows a warning (also in `--json` as `revocations_dropped`) that the server was never told, so an admin can remove that installation from the dashboard.
