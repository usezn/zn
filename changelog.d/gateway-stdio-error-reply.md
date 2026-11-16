### Fixed

- The experimental Rust gateway (not distributed) now answers a JSON-RPC error (code -32603, with the request id when it can be read) when it fails to process a message on stdio, instead of dropping the message and leaving the client waiting.
