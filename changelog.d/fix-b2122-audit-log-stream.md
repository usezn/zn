### Fixed
- Team audit upload, `zn vault verify` and `zn team status` now read the local audit log in chunks instead of loading it whole, so a log larger than about 512 MiB no longer stops uploads and verification for good.
- A local audit log that cannot be read (permissions, disk error) is now reported as a read error with a plain message. It is no longer recorded as a sign that the log was changed, so `zn vault verify --acknowledge` is not needed for it.
