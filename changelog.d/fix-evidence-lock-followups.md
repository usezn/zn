### Fixed
- The evidence log write lock is more robust: a lock that another process had just renewed is no longer deleted when two processes break an old lock at the same moment, leftover files from broken locks are cleaned up, and an invalid lock wait time (not a number, infinite or negative) uses the default wait instead of waiting too long.
