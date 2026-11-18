### Fixed
- A panic while one request is handled no longer ends the whole gateway. The management API answers `500` to that request and keeps serving, and a JSON-RPC message that panics while it is checked gets an error reply and is not forwarded. Integer overflow in the gateway now stops the request instead of wrapping silently.
