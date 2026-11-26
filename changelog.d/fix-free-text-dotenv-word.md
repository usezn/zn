### Fixed
- An MCP call whose search, title or message is only the word `.env` (for example a search for ".env") is no longer refused as
  if it named the file. A path to `.env` under the same keys (`./.env`, `sub/.env`), and `.env` under a file key or any other
  key, is still refused.
