### Fixed
- Two secrets on adjacent lines, a key wrapped across two lines next to another key, and a wrapped key followed by
  a wrapped key of another kind are now reported the same way by the Node.js and Python scrubbers: one detection per
  key with its own rule name. Before, one key could take over the start of the next one and leave the rest of it
  readable, and the Node.js scrubber left the first 20 characters of a GitHub token readable when a whole AWS key
  followed on the next line.
