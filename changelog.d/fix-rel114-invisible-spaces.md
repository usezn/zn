### Security
- Invisible characters used as spaces between words (for example a zero-width space or a Hangul filler in "ignore all previous instructions") no longer hide an instruction from the prompt-injection rules. The Rust engine now strips the same invisible characters as the Node.js and Python engines, and all three read their list from one shared table.
