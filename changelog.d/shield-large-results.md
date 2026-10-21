### Security
- `zn-gate shield` now checks tool results in full up to 32 MB. Before, only the first 4 MB and the last 256 KB of a larger result were checked, so an instruction placed in the middle of a large result reached the agent. A result over 32 MB is now removed, with a notice asking for a smaller part.
