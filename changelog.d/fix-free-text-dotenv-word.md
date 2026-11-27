### Fixed
- A call to an MCP tool whose name says it only reads or searches (for example `search_docs` or `find`) is no longer refused
  when its search, title or message is only the word `.env` (a search for ".env"). Any other tool, including one zn cannot place
  from its name, is still refused, since it may use a title or message as the file it writes. A path to `.env` under the same
  keys (`./.env`, `sub/.env`), and `.env` under a file key or any other key, is still refused.
