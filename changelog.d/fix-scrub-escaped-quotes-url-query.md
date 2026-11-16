### Fixed
- The scrubber now redacts a secret assigned with backslash-escaped quotes inside a JSON string (`"cmd": "export api_key=\"value\""`) and a secret passed as a URL query parameter (`?api_key=value`, `&token=value`). The value is redacted up to the next `&`, `#`, quote or whitespace. Other query parameters, placeholders, references and short values are left as they are.
