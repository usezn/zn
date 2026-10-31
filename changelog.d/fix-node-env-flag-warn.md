### Fixed
- Node.js: `ZN_STRICT` and `ZN_BLOCK_TRUNCATED` turn on only with the value `1`. Another value such as `true` or `yes` left them off without a word; now a warning on stderr says so, once per value, as in Python.
