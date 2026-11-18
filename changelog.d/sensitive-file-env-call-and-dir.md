### Fixed
- The sensitive-file rule no longer blocks code that only mentions `.env` as a method call (for example a chained `.env("KEY", "value")`) or as a folder (a virtualenv at `.env/`). Real secret files such as `.env`, `.env.local` and `.env.production` are still blocked, in both the Node.js and Python packages.
