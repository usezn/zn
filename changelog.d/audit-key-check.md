### Security
- The audit log now refuses to open with the wrong passphrase instead of quietly writing new records under a different key that the right passphrase could not read. The check is stored when a database is first opened with a key (for existing databases, once a stored record has proved the key right).
