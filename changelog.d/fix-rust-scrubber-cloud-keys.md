### Fixed
- The gateway scrubber now hides cloud credentials: AWS access key ids and named AWS secret access keys, Google API keys, PEM private keys (including service-account `private_key` values) and Azure storage account keys, with the same labels as the Node.js scrubber.
- The gateway now scrubs the string values of a JSON-RPC message after parsing it, instead of scrubbing the raw line. A secret at the end of a string no longer breaks the message with a "Parse error: Invalid JSON" reply.
