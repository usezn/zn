### Security
- The library checks (the Python and Node.js APIs) now refuse the same glued .env spellings as the hook: sort -o.env, grep -f.env, diff -u.env and a sed write or read command with the file attached (w.env, r.env, s/a/b/w.env). Before, a shell tool guarded only by the library could read or overwrite a project .env this way.
