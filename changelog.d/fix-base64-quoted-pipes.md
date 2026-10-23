### Security
- Rules, Node.js and Python: the Base64 decode check now also reads a quoted payload (`echo '...' | base64 -d`), `echo` options (`echo -n`), `printf` with or without a `%s` format (`printf '%s' '...'`), the `-di` flag and a here-string (`base64 -d <<< ...`). Before, these forms were allowed even when the decoded command is blocked on its own.
