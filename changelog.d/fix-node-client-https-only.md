### Security
- The Node.js cloud client now refuses a `ZN_API_URL` or `--url` that is not `https://` before it sends anything, so an API key you
  give with `--key` or `ZN_API_KEY` can no longer travel in clear text. Plain `http://` is accepted only for `localhost`,
  `127.0.0.1` and `::1`, the same rule as the Python client. A refused call falls back to the local rules like any other cloud error.
