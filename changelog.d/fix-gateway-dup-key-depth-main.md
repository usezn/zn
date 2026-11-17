### Security
- The experimental Rust gateway (not distributed) refuses a frame nested more than 64 levels deep, and its repeated-key check refuses any frame it cannot read to the end. Before, a deeply nested unknown field let a frame with a repeated key in its tool arguments, tool name or A2A task pass that check.
