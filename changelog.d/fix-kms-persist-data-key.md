### Fixed
- With AWS KMS, the gateway now keeps using the same data key across restarts, so earlier audit records stay readable. The encrypted key is saved next to the audit database; the gateway refuses to start, instead of creating a new key, if that file is damaged, KMS cannot decrypt it, or `kms.key_id` changed.
