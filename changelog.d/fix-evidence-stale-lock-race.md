### Fixed
- When several processes write the evidence log and meet a stale lock file at the same time, a writer could break another writer's fresh lock and make it skip its record ("the write lock was taken over"). Only one writer at a time now breaks a stale lock, and it checks again that the lock is still stale before removing it.
