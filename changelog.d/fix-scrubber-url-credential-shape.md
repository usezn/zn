### Fixed
- The npm scrubber hides only the password of a URL with a login (`https://user:password@host/...`, `mongodb+srv://...`) and keeps the host readable. It used to read `password@host` as an e-mail address and hide the host too. The password is hidden as before.
- The Python `zn-gate test` preview keeps the quotes of a quoted password (`password = '[REDACTED_PASSWORD]'`), as the npm package does, so the text stays valid.
