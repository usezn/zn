### Fixed
- The gateway scrubber now redacts a secret in a JSON member such as `{"api_key": "<value>"}` (also with single quotes, spaces around the colon, or inside an escaped JSON string), as the Node scrubber already did. The quotes stay in the output, so redacted JSON is still valid JSON.
- The gateway scrubber now redacts `name="<value>"` when it sits inside a JSON string with escaped quotes, for example a shell command in a tool call.
- The gateway scrubber now redacts the token in `Authorization: Bearer <token>` (also Basic and Token, quoted or in a JSON member), where the header has no `=` after the name. Placeholders and short plain words are left alone.
