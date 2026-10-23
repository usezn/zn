### Fixed
- The Rust gateway in `src/` (experimental, not distributed) now redacts the same secret key names as the Node.js scrubber, such as `client_secret`, `secret`, `passwd`, `passphrase`, `private_key`, `credentials` and `aws_secret_access_key`. One shared list of names is checked by both test suites.
