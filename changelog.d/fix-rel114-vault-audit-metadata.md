### Security
- The audit log of the Rust gateway stores only metadata by default (event, time, tool, status, policy, agent, namespace). The scrubbed request payload is no longer written unless `audit.store_payloads` (or `ZN_AUDIT_STORE_PAYLOADS=1`) is set, and that option needs an encryption key (`ZN_DB_KEY` or a KMS key) in every environment. Existing records stay readable.
