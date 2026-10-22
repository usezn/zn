### Fixed
- A hook event that repeats a key at the top level is now refused whatever its size. Such an event could be read two ways, and a hand-made one could be treated as a post-tool event when the agent meant something else. Keys repeated inside the tool arguments or output are unaffected.
