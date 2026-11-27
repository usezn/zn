### Fixed
- A search for ".env" through an MCP tool is no longer refused: when the search query (`q`, `query`, `search`, `search_query`,
  `search_term`, `keywords`) is only the word `.env` and the tool's name says it only reads or searches (for example
  `search_docs` or `find`), the call passes. A path to `.env` in the query (`./.env`, `sub/.env`), `.env` under any other key
  (including `title`, `message` and `body`, which a tool that writes can use as a file name), a `.env` in a list of queries,
  and calls to any other tool are still refused.
