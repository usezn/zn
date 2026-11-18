### Added
- The Rust gateway can delete old audit records: set `audit.retention_days` (or `ZN_AUDIT_RETENTION_DAYS`) to a number of days and it removes older records at start and then every hour, zeroing the deleted text and compacting the file. It is off by default. A value that is not a whole number of days from 1 to 36500 stops the start.
