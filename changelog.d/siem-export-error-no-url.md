### Security
- The SIEM exporter no longer writes the endpoint URL into its network error log line. A token in the URL path or query could reach stderr when a connection failed.
