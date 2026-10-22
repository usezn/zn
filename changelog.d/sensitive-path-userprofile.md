### Security
- The rule for protected files now also finds credential and environment files after `@` or `=` when the Windows home is written as `$USERPROFILE`, `${USERPROFILE}` or `${env:USERPROFILE}`, not only `%USERPROFILE%` or `$env:USERPROFILE`. Ordinary files under that folder are still allowed. The Node.js and Python packages give the same verdicts.
