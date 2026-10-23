### Fixed
- A long run of spaces after a header name in text the scrubber reads no longer slows it down: the check for header-style fields such as `X-User-Name` now takes time in proportion to the text, not its square.
