### Fixed
- The restricted-command rule no longer blocks a `format` parameter such as `{"format":"csv"}`. Commands named in the arguments, such as `format c:` or `rm -rf`, are still blocked.
