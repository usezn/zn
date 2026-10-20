### Fixed
- `zn env shadow` and `zn secret import` no longer say "shorter than 8 characters" for a long connection URL whose password is short. The whole URL now moves to the vault, so the password no longer stays in `.env` in plain text, and a note says so. A short plain value that cannot be moved now says how long it is, that it stays in the file in plain text, and what to do about it.
