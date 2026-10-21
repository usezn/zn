### Fixed
- `zn start` now stops with a clear message when `security.rate_limit_per_minute` is `0`, instead of crashing. Use a value of at least 1.
- `zn start` also stops with a clear message when `caching.ttl_seconds` is more than one year, and a huge cache lifetime no longer crashes the gateway.
