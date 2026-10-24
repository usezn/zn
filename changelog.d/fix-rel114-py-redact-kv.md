### Security
- `redactSecrets` (Node.js) and `redact_secrets` (Python) now hide a quoted password, token or key that contains spaces, up to its closing quote (for example `"password":"abcdefgh ijk lmn"`); before, such a value was left in the clear.
- Both now hide a number stored under a secret key (`{"token":12345678}`) and keep the JSON valid by writing the replacement as a string.
