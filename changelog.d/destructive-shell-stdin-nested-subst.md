### Security
- The download-and-run check now also blocks a shell that reads its program from a substitution on its input: `bash < <(curl URL)`, `bash -s < <(curl URL)`, `sh <<< "$(curl URL)"`, and a downloader with a backslash inside its name (`bash -c "$(c\url URL)"`). `bash < <(echo hi)` and `cat <<< "$(curl URL)"` stay allowed.
- A command with many nested `$( ... )` substitutions is no longer slow to check for outgoing requests: each substitution is read once, and the whole check has one work limit that reports the command instead of running long.
