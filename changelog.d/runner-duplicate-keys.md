### Fixed
- A hook event that is too large to read and repeats a key at the top level is now refused, because it could be read two different ways.
- For Copilot, a too-large event is now recognised as a post-tool event exactly as the Copilot adapter does (event name with a lower-case first letter, and a null result is not a result).
