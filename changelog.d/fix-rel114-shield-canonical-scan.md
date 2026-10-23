### Security
- The MCP shield now also checks all the text of a server message as one, after checking each field. An injection split across fields of a tool result, a notification or a server request, each harmless alone, is now blocked. A message whose text is over the scan limit is blocked as a whole instead of passing the part that was not checked.
