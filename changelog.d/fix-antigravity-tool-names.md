### Fixed
- Antigravity hooks now check the tool names Antigravity really uses (`read_file`, `write_file`, `edit_file`, `view_file`, `list_dir`, `find_by_name`), and no longer read the text in the `Target` argument of `edit_file` as a file path.
