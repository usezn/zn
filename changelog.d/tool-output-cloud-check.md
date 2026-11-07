### Added
- With the optional cloud check on (`ZN_CLOUD=1` with a key, or `zn-gate connect`), the Claude Code hook now also sends a sample of the results of web fetches, MCP tools and shell commands to the zn cloud to look for hidden instructions aimed at the agent. This is new: until now tool output never left your machine. The sample is at most 16 KiB (the first 12 KiB and the last 4 KiB), is sent only after secrets are replaced (personal data is not removed), skips a result the local check already flagged, and goes only to `api.usezn.com`. The cloud answer can only add the note the local check adds; if the call fails nothing is blocked or changed. With the cloud check off nothing is sent. Other agents send nothing. `{"hooks": {"cloudCheckToolOutput": false}}` in `~/.zn/config.json` turns off just this path and keeps the prompt check.

### Changed
- The data-flow notes in the READMEs and docs now say that tool output is sent in this one opt-in case.
