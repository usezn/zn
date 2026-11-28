### Security
- `ZN_LOCAL_ONLY` now accepts `1`, `true`, `yes` and `on` (any case) in both the npm and the Python package. Before, only the exact
  value `true` kept the cloud off: with `ZN_CLOUD=1` and an API key, `ZN_LOCAL_ONLY=1` (or `yes`, `on`, `TRUE`) was ignored without a warning and the prompt
  text, with secrets already redacted, was sent to the cloud check. Any other non-empty value that is not an off value (`0`, `false`, `no`, `off`) also
  keeps local-only on and is reported once, so a typo never sends text. Affects the npm package since 1.2.2 and the Python package since 1.2.4.

### Fixed
- The Base64 decode check in both packages no longer catches every error around the decoded text: only a payload that cannot be decoded is skipped.
  An unexpected error while checking the decoded text now reaches the caller like any other check error, instead of letting the input through.
