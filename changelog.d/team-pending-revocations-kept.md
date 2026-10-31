### Fixed

- `zn team leave`: a revocation the server has not confirmed is never dropped any more. Every installation that left while the server could not be reached is kept and retried, and the pending-revocation warning stays in `zn team status` until the server confirms. With 64 unconfirmed leaves, a further leave is refused with a message saying what to do. Up to 1.15.0-rc.1, waiting revocations beyond the eighth were dropped without any record, so an organization admin should review the installations in the dashboard and remove any that should be gone.
