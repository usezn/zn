### Security
- The shield now checks every string nested inside `default`, `const`, `enum` and `examples` values of a tool schema (objects and arrays at any depth, within the same limits), and the tool `title` and `annotations.title`, with the same rule as descriptions.
