### Fixed
- The gateway no longer grows in memory with every WebSocket connection: a connection's reputation and loop-breaker entries are removed when it closes, idle entries are dropped after 30 minutes, and the number of entries is capped. Active bans are never dropped early.
