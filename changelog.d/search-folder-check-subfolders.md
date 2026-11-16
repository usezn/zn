### Fixed
- The check that asks before a search over a folder with a `.env` or key file now looks in subfolders too (up to 8 levels and 10,000 names, without `node_modules` and `.git`) and asks when a folder is too large or too deep to check, instead of reading only the first 5,000 names of the top level.
