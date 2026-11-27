### Security
- The Python cloud client no longer follows redirects, so the API key is never sent to a URL other than the endpoint you set.
  It also refuses endpoints that are not `https://` (plain `http://` is accepted only for `localhost`, `127.0.0.1` and `::1`)
  and API keys that are not 16 to 256 letters, digits, dots, underscores or dashes, the same key rule as the Node.js client.
  A refused call falls back to the local rules like any other cloud error.
