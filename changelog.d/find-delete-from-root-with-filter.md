### Security
- A `find` that starts at the filesystem root and deletes (`-delete`, or `-exec rm`) is now refused even when it has a filter such as `-name` or `-type`. A filter does not make a delete from the root safe. `find` inside your project, and `find` from the root without a delete, stay allowed.
