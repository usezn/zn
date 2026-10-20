### Security
- A server's HTTP status text is now scrubbed like the body and headers in `secrets_http_request`, so a server that echoes a secret in its status line no longer returns it to the agent.
- The shield now checks every description and title in a tool's input schema, not only the top-level properties: nested object properties, array items, `anyOf`/`oneOf`/`allOf` branches and `$defs` are covered, with a depth limit and protection against circular schemas.
- A tool schema too deep or too large for the shield to check is no longer passed on unchecked: the tool is replaced by a plain notice and zn-gate prints which tool and which limit on stderr.
- The shield now also checks `default`, `enum`, `const`, `examples`, `$comment` and `outputSchema` text in tool schemas.
- `secrets_http_request` scrubs response header names as well as values.
