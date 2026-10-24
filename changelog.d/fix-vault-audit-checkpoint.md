### Security
- The vault audit check (`zn vault verify`) now compares the last record the vault remembers by sequence number and MAC, not only by record count, so a tail lost after a crash, or replaced by other records, is reported. The vault saves that checkpoint every minute and when it locks, so a crash can still lose up to a minute of records without notice.
