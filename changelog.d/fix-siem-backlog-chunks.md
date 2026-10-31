### Fixed
- After a SIEM outage the retry buffer is now sent in several requests of at most 500 events and about 1 MiB each, oldest first, instead of one request with the whole backlog; if one request fails, the unsent rest stays buffered. The queue in front of the exporter is also capped at about 8 MiB, so a burst of large events cannot fill memory.
