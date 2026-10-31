### Fixed
- `zn team leave`: every installation the server has not yet confirmed as revoked is now kept and retried, not just the last 8, and the pending-revocation warning no longer disappears after 30 days. It stays in `zn team status` until the server confirms. With 64 unconfirmed leaves, a further leave is refused with a message saying what to do, instead of dropping any.
