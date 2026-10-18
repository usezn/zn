### Security
- Encrypted audit log payloads are now tied to the id and namespace of their record: a payload copied to another record, or a record moved to another namespace, no longer decrypts. Records written before this change stay readable.
