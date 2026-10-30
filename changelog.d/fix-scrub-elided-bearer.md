### Fixed
- The prompt scrubber no longer masks an elided token after `Authorization: Bearer`, such as `Bearer abc123...` or `Bearer abc123…`, as a credential. A full token is still masked.
