### Security
- A project `.env` named in a list of file names in a tool call is now refused: under a file key (`path`, `target` and the
  like) each name between tabs, commas or spaces is checked (`"notes.txt,.env"`), and the Unicode line and paragraph
  separators split lines like a line break. Free text under other keys is not split, so a search for "how to load .env" still
  passes.
