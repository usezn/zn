### Fixed
- Python: the scrubber now also redacts a secret split by shell quoting or written with percent-encoding, a secret assigned with backslash-escaped quotes inside a JSON string, and a secret passed as a URL query parameter, matching the Node.js scrubber.
