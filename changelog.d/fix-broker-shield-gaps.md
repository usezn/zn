### Security
- A server's HTTP status text is now scrubbed like the body and headers in `secrets_http_request`, so a server that echoes a secret in its status line no longer returns it to the agent.
- The shield now checks every description and title in a tool's input schema, not only the top-level properties: nested object properties, array items, `anyOf`/`oneOf`/`allOf` branches and `$defs` are covered, with a depth limit and protection against circular schemas.
