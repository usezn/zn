### Fixed
- A GitHub token no longer takes the next line with it. When the token is complete on its line and the line after it
  is a plain word (for example `run-deploy`), both the Node.js and the Python package keep that line; before, the
  Node.js package could redact the first word of it before a hyphen and the Python package the first word before a dot.
  A token that wraps onto a line of key material is still redacted whole.
