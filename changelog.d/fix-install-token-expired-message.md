### Changed
- Team install tokens now expire after 90 days without a sync and renew each time a sync works. When one has expired, `zn team sync` says so, keeps applying the last policy, and tells you to run `zn team leave` and join again with a new token, instead of reporting that the machine was removed.
