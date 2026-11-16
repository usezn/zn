### Security

- The check for plaintext credentials in MCP server configs now also checks arguments longer than 4,096 characters (for example `--api-key=<value>` or `Authorization: Bearer <value>`), in both the npm and the Python package. Before, such an argument was skipped. Very long crafted arguments still take linear time.
