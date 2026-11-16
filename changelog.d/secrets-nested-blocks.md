### Security

- The check for plaintext credentials in MCP server configs no longer stops following an object or array under a credential name (such as `"api_key"`) after 200 lines, 8 levels of nesting or an array inside an array. A value inside such a block is now reported however long or deep the block is, in both the npm and the Python package; past 64 levels every value is checked as a value of that name.
