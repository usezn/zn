### Fixed
- The gateway now refuses an invalid local vault key instead of ignoring it. A key that is not valid hex, or not exactly 32 bytes, stops startup with a clear error that does not show the key.
