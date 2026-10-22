### Security

- Tool output and proxied server text larger than the single-scan size are now checked for Base64 decode pipes as a whole before the windowed scan, as tool-call arguments already were, so a long pipe that crosses a window edge is decoded and checked.
