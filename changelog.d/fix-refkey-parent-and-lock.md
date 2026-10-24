### Security
- The folder that holds the audit reference key (`ref.key`) must now be a real folder owned by the current user that group and others cannot write to; otherwise the gateway refuses to start with a clear error. When several processes find a truncated key at the same time, one replaces it under a lock file and the others use the key it wrote, so they never end up with different keys.
