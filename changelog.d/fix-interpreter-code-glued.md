### Fixed
- The destructive-command check (`rm_root_home`) also reads interpreter code glued to its option, such as `python3 -c"..."` or `perl -e'...'`. It looks for the recursive option of a delete call only after its argument names a protected folder, which keeps long commands fast. Node.js and Python.
