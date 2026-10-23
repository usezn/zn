### Security
- The gateway scrubber now redacts a quoted password, token or key that contains spaces up to its closing quote (for example `"password":"abcdefgh ijk lmn"`); before, such a value was left in the clear.
- The gateway scrubber no longer breaks valid JSON: a number in a secret field (`{"token":12345678}`) is replaced with a quoted `"[SECRET_REDACTED]"` string.
