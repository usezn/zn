### Fixed
- Python: `ZN_STRICT` and `ZN_BLOCK_TRUNCATED` turn on only with the value `1`. Another value such as `true` or `yes` left them off without a word; now a warning (logger `zn_gate`) says so, once per value.
