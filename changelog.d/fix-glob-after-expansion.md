### Fixed
- The hook policy now also reads a glob in a later path segment of a word that holds a variable or command substitution, so `cat $PWD/.e*` no longer reads a `.env` file.
