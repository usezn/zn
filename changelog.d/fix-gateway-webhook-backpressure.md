### Fixed
- The Rust gateway no longer lets a slow or unreachable webhook endpoint grow its memory or delay the alerts of other endpoints: alerts wait in a bounded queue per endpoint, a full queue drops the new alert and counts it (`zn_webhook_alerts_dropped_total`), and each send times out after `timeout_secs` (default 3 seconds) instead of 10.
