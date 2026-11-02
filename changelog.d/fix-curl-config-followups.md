### Security
- The pre-tool check now also refuses a command that downloads into a place built from a variable zn does not resolve (`curl -o $F`, `curl --output=$F`, `wget -O $F`) when a curl in the same command reads a configuration, since that file may be the configuration itself. A curl that redirects its own output (`curl URL > $F`) is no longer excused when it sits in a `for`, `while` or `until` loop or reads a `-K` file, because the next pass reads what the last one wrote.

### Fixed
- `curl URL | tee $LOG` is allowed again: `tee` there only takes the output of a curl that has already read its configuration. A `tee` fed by anything else, or followed by another curl, is still refused. `curl --data-raw @$NAME` is allowed too, since `--data-raw` never reads a file.
