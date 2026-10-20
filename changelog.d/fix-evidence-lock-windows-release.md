### Fixed
- The Python package now breaks a stale evidence-log lock the same way the Node package does: one writer at a time, re-checking that the lock is still stale, so a Python writer can no longer remove another writer's fresh lock and make it skip a record.
- On Windows, a writer now retries briefly when deleting the evidence-log lock fails because another program has the file open. Before, the lock could stay behind for up to 10 seconds and make other writers skip their records.
