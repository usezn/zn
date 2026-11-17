### Security
- The experimental Rust gateway (not distributed) refuses a frame nested more than 64 levels deep, and its repeated-key check refuses any frame it cannot read to the end. Before, a deeply nested unknown field let a frame with a repeated key in its tool arguments, tool name or A2A task pass that check.
- The experimental Rust gateway bounds the key and value lengths a WASM policy passes to its state functions before allocating, so a policy can no longer make the gateway allocate an arbitrary size.
- The experimental Rust gateway refuses to start when a policy file in its policy folder cannot be loaded, instead of starting without that policy.
