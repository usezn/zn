### Security
- The experimental Rust gateway (not distributed) now checks every tool-call argument key (`arguments`, `args` and `input`) when a request carries more than one, instead of only the first one found.
- A frame that repeats a key in any JSON object is now refused before any check, because only the last copy of a repeated key would have been checked.
