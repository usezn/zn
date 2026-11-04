### Added
- `zn-gate scan --package <name>[@version]` audits an npm MCP server or skill before you add it. The package is downloaded from the registry, checked against its checksum, unpacked to a temporary folder and scanned, together with the agent-config audit. Nothing in it is installed or run. Exit `2` when the package cannot be fetched or is refused, so it is not mistaken for findings.
