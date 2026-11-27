### Fixed
- A search for the word ".env" through an MCP search tool is no longer refused: the call passes when the search query (`q`,
  `query`, `search`, `search_query`, `search_term` or `keywords`) is exactly `.env` and every word of the tool's name is a search
  word (for example `search_docs`, `web_search` or `find`). A tool with any other word in its name (such as `read_file`, `get`,
  `fetch`, `open` or an unknown server name), a longer name such as `.env.local`, a path (`./.env`, `sub/.env`), `.env` under any
  other key (including `title`, `message` and `body`) and a `.env` in a list of queries are still refused.
