### Fixed
- When ZCode's settings file or plugin files cannot be read as JSON, `zn-gate check` now says why in one plain sentence (the file has comments, or is not valid JSON at a given line) and that the file was left unchanged. Before, it showed a generic message or nothing. A byte order mark is accepted, as in the other agents' settings files.
