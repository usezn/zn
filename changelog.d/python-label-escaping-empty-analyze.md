### Fixed
- Security: `zn-gate stats` in the Python package now replaces control characters and terminal escape sequences in the agent, layer and secret-type labels it prints, so a crafted label in the stats file can no longer rewrite your terminal.
- `zn-gate analyze ""` in the Python package now prints the usage and exits `2` instead of returning an allow verdict with exit `0`, as documented.
