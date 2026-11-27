### Fixed
- When two different secrets sit on adjacent lines (for example an OpenAI-style key and a PyPI token), the scrubber now
  reports each one with its own rule name. Before, the two lines were read as one key wrapped across a line break and
  reported as a single detection with one rule name. Both secrets were already redacted. A key wrapped across two lines
  is still one detection. Node.js and Python behave the same.
