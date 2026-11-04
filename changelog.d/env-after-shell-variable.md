### Fixed
- The secret-file checks now also catch a .env file that is reached through a shell variable, such as `cat $IFS.env`, `cat ${IFS}.env` or `cat $1.env`. The shell expands these to whitespace or an empty value, so the command reads the real .env file. A file name such as `$APP.env` is blocked as well, because it can expand to a bare .env.
