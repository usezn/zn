### Security
- OpenCode: the query of the built-in `websearch` and `codesearch` tools is now checked before it is sent, like the arguments of an MCP call to a server that is not zn's own, so a secret value or a secret placeholder in a search query is refused instead of being sent to the search service. `task`, `glob`, `list` and `skill` stay on the machine and are not changed.
