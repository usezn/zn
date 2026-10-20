### Fixed
- The evidence log no longer loses a record when writers race to break a stale lock. The short-lived mutex used for breaking is now removed only by the process that created it, so a slow writer can no longer delete one that another writer has since taken. The same fix is in the Node.js and Python packages, which still share one log.
