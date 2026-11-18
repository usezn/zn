### Security
- The Rust gateway no longer logs full webhook URLs, webhook response bodies, SIEM request URLs or upstream MCP WebSocket URLs. Logs keep the scheme and host and, for webhooks, the HTTP status; paths, query strings and user info are dropped, and the URL is stripped from network error messages.
