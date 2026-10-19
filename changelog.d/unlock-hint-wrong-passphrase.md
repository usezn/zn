### Fixed
- `zn unlock` shows the "forgot the passphrase" reset hint only after three wrong passphrases in a row. A damaged vault file or a keychain error no longer counts toward it: those get a different hint that says not to reset, and they restart the count.
