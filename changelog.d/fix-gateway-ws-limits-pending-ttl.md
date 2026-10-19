### Fixed
- The gateway's WebSocket handler now has explicit, configurable limits on message and frame size (`server.ws_max_message_bytes`, default 1 MiB, and `server.ws_max_frame_bytes`, default 256 KiB); a larger message closes the connection.
- Consensus actions in the gateway now expire: an action not approved within `consensus.pending_ttl_secs` (default 15 minutes) can no longer be approved and is removed.
