### Security
- The Python `redact_secrets` now hides a quoted password, token or key that contains spaces, up to its closing quote (for example `"password":"abcdefgh ijk lmn"`); before, such a value was left in the clear.
- The Python `redact_secrets` now hides a number stored under a secret key (`{"token":12345678}`) and keeps the JSON valid by writing the replacement as a string.
