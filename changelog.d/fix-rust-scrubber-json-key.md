### Fixed
- The gateway scrubber now redacts a secret in a JSON member such as `{"api_key": "<value>"}` (also with single quotes, spaces around the colon, or inside an escaped JSON string), as the Node scrubber already did. The quotes stay in the output, so redacted JSON is still valid JSON.
